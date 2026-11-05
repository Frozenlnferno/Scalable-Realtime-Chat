import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { createDatabase, databaseSettings } from "../src/core/database/client.js";

test("PostgreSQL user synchronization, atomic messages and bounded waits", {
  skip: !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL to an isolated PostgreSQL test database",
}, async t => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  const schema = `chat_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url.toString() });
  let pool;
  t.after(async () => {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
  const database = await import("../src/core/database/pool.js");
  pool = database.pool;
  await pool.query(await readFile(new URL("../migrations/001_initial_schema.sql", import.meta.url), "utf8"));
  const users = await import("../src/features/users/user.repository.js");
  const conversations = await import("../src/features/conversations/conversation.repository.js");
  const messages = await import("../src/features/messages/message.repository.js");
  const { sendMessage } = await import("../src/features/messages/message.service.js");
  const { setSocketServer } = await import("../src/core/socket/socket.events.js");
  const { createApp } = await import("../src/app.js");
  const { createAuthenticator } = await import("../src/core/auth/authenticate.js");
  const { requestTiming } = await import("../src/core/diagnostics/request-timing.js");

  let first, second, conversation;
  await t.test("existing users are read without writes; changed users sync; creation is race safe", async () => {
    first = await users.upsert({ cognitoSub: "first", email: "first@test.invalid" });
    const before = (await pool.query("SELECT xmin::text, updated_at FROM users WHERE id=$1", [first.id])).rows[0];
    const unchanged = await users.upsert({ cognitoSub: "first", email: first.email });
    const after = (await pool.query("SELECT xmin::text, updated_at FROM users WHERE id=$1", [first.id])).rows[0];
    assert.equal(unchanged.id, first.id); assert.deepEqual(after, before);
    const changed = await users.upsert({ cognitoSub: "first", email: "changed@test.invalid" });
    assert.equal(changed.id, first.id); assert.equal(changed.email, "changed@test.invalid");
    const concurrent = await Promise.all(Array.from({ length: 10 }, () => users.upsert({ cognitoSub: "second", email: "second@test.invalid" })));
    assert.equal(new Set(concurrent.map(user => user.id)).size, 1);
    second = concurrent[0];
    conversation = await conversations.createOrFindDirectConversation(first.id, second.id);
  });

  await t.test("message/timestamp commit together and failed timestamp writes roll back without emission", async () => {
    const events = [];
    setSocketServer({ to: room => ({ emit: (event, message) => events.push({ room, event, message }) }) });
    await pool.query("UPDATE conversations SET updated_at='2000-01-01' WHERE id=$1", [conversation.id]);
    await pool.query(`CREATE FUNCTION fail_touch() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test timestamp failure'; END $$`);
    await pool.query("CREATE TRIGGER fail_touch BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION fail_touch()");
    try {
      await assert.rejects(sendMessage(conversation.id, first.id, "rollback"));
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM messages")).rows[0].n, 0);
      assert.equal((await pool.query("SELECT updated_at FROM conversations WHERE id=$1", [conversation.id])).rows[0].updated_at.getUTCFullYear(), 2000);
      assert.equal(events.length, 0);
    } finally { await pool.query("DROP TRIGGER fail_touch ON conversations"); }
    const saved = await sendMessage(conversation.id, first.id, "success");
    assert.equal(saved.body, "success"); assert.equal(saved.senderId, first.id);
    assert.equal(events.length, 2); assert.ok(events.every(event => event.message.id === saved.id));
    assert.ok((await pool.query("SELECT updated_at FROM conversations WHERE id=$1", [conversation.id])).rows[0].updated_at.getUTCFullYear() > 2000);
    const page = await messages.listByConversation(conversation.id, null, 50);
    assert.equal(page.length, 1); assert.equal(page[0].id, saved.id);
    await assert.rejects(sendMessage(conversation.id, randomUUID(), "unauthorized"), error => error.status === 404);
    assert.equal(events.length, 2);
  });

  await t.test("real HTTP message/history path has one user read and three database calls", async () => {
    const logs = [];
    const auth = createAuthenticator(async () => ({ cognitoSub: "first", email: "changed@test.invalid" }), users.upsert);
    const authenticate = async (req, _res, next) => {
      try { req.user = await auth("verified in test"); next(); } catch (error) { next(error); }
    };
    const server = createApp({ authenticate, timing: requestTiming({ pool, enabled: true, slowMs: 0, logger: line => logs.push(JSON.parse(line)) }) }).listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/conversations/${conversation.id}/messages`;
      const sent = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "http" }) });
      assert.equal(sent.status, 201);
      assert.equal((await sent.json()).message.body, "http");
      assert.equal(logs[0].dbCalls, 3);
      assert.deepEqual(Object.keys(logs[0].dbOperations).sort(), ["conversations.participant", "messages.insert_and_touch", "users.resolve"]);
      const history = await fetch(base); assert.equal(history.status, 200);
      assert.equal((await history.json()).messages.length, 2);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  await t.test("actual acquisition, lock and statement timeouts release connections and bound queues", async () => {
    const settings = databaseSettings({ DB_POOL_MAX: "1", DB_POOL_MAX_WAITING: "1", DB_POOL_ACQUIRE_TIMEOUT_MS: "100",
      DB_STATEMENT_TIMEOUT_MS: "200", DB_LOCK_TIMEOUT_MS: "50" });
    const limited = new pg.Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 100,
      statement_timeout: 200, lock_timeout: 50 });
    const db = createDatabase(limited, settings);
    let held, locker;
    try {
      held = await limited.connect();
      const queued = assert.rejects(db.query("test", "SELECT 1"), error => error.diagnosticCode === "db_acquire_timeout");
      assert.equal(limited.waitingCount, 1);
      await assert.rejects(db.query("test", "SELECT 1"), error => error.diagnosticCode === "db_overloaded");
      assert.equal(limited.waitingCount, 1);
      await queued;
      held.release(); held = null;
      assert.equal(limited.waitingCount, 0);
      await assert.rejects(db.query("test", "SELECT pg_sleep(1)"), error => error.diagnosticCode === "db_statement_timeout");
      locker = await pool.connect();
      await locker.query("BEGIN");
      await locker.query("UPDATE conversations SET updated_at=NOW() WHERE id=$1", [conversation.id]);
      await assert.rejects(db.query("test", "UPDATE conversations SET updated_at=NOW() WHERE id=$1", [conversation.id]), error => error.diagnosticCode === "db_lock_timeout");
      await locker.query("ROLLBACK"); locker.release(); locker = null;
      assert.equal((await db.query("test", "SELECT 1 AS n")).rows[0].n, 1);
    } finally {
      held?.release();
      if (locker) { await locker.query("ROLLBACK"); locker.release(); }
      await limited.end();
    }
  });
});
