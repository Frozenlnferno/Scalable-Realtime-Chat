import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createDatabase, databaseSettings, observePoolErrors } from "../src/core/database/client.js";
import { requestTiming } from "../src/core/diagnostics/request-timing.js";

test("database settings validate finite integer limits and lock timeout ordering", () => {
  assert.equal(databaseSettings({}).DB_POOL_MAX, 10);
  assert.equal(databaseSettings({ DB_POOL_MAX_WAITING: "0" }).DB_POOL_MAX_WAITING, 0);
  for (const value of ["", "0", "-1", "NaN", "Infinity", "1.5"]) {
    assert.throws(() => databaseSettings({ DB_POOL_MAX: value }));
  }
  assert.throws(() => databaseSettings({ DB_LOCK_TIMEOUT_MS: "5000" }));
});

for (const enabled of [false, true]) {
  test(`overload/error mapping and release with diagnostics ${enabled}`, async () => {
    const logs = [], settings = databaseSettings({ DB_POOL_MAX: "1", DB_POOL_MAX_WAITING: "1" });
    const pool = { options: { max: 1 }, totalCount: 1, idleCount: 0, waitingCount: 1,
      connect() { assert.fail("saturated queue must not grow"); } };
    const middleware = requestTiming({ pool, enabled, slowMs: 0, logger: row => logs.push(row) });
    const within = work => new Promise((resolve, reject) => {
      const res = Object.assign(new EventEmitter(), { statusCode: 503 });
      middleware({ method: "POST" }, res, () => work().then(() => { res.emit("finish"); resolve(); }, reject));
    });
    await within(async () => {
      await assert.rejects(createDatabase(pool, settings).query("messages.insert", "SECRET"),
        error => error.status === 503 && error.diagnosticCode === "db_overloaded");
    });
    if (enabled) assert.equal(JSON.parse(logs[0]).dbErrors.db_overloaded, 1);
    else assert.equal(logs.length, 0);
    pool.waitingCount = 0;
    pool.connect = async () => { throw new Error("timeout exceeded when trying to connect"); };
    await within(async () => {
      await assert.rejects(createDatabase(pool, settings).query("users.resolve", "SECRET"),
        error => error.status === 503 && error.diagnosticCode === "db_acquire_timeout");
    });
    for (const [code, expected] of [["57014", "db_statement_timeout"], ["55P03", "db_lock_timeout"],
      ["08006", "db_unavailable"], ["ECONNRESET", "db_unavailable"], ["53300", "db_unavailable"], ["23505", null]]) {
      const original = Object.assign(new Error("SECRET"), { code }), releases = [];
      const client = Object.assign(new EventEmitter(), { async query() { throw original; }, release(error) { releases.push(error); } });
      pool.connect = async () => client;
      await within(async () => {
        await assert.rejects(createDatabase(pool, settings).query("messages.insert", "SECRET"),
          error => expected ? error.status === 503 && error.diagnosticCode === expected && !error.message.includes("SECRET") : error === original);
      });
      assert.deepEqual(releases, [original]); assert.equal(client.listenerCount("error"), 0);
    }
    assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
  });
}

test("idle pool failures are handled without logging connection details", () => {
  const pool = new EventEmitter(), logs = [];
  observePoolErrors(pool, line => logs.push(line));
  pool.emit("error", new Error("SECRET postgresql://password"));
  assert.equal(JSON.parse(logs[0]).code, "db_unavailable");
  assert.doesNotMatch(logs[0], /SECRET|password/);
});
