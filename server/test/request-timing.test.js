import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { requestTiming } from "../src/core/diagnostics/request-timing.js";
import { createDatabase, databaseSettings } from "../src/core/database/client.js";

const timedQuery = (pool, operation, text, values) => createDatabase(pool, databaseSettings()).query(operation, text, values);

function response() {
  return Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false });
}
const client = (methods) => Object.assign(new EventEmitter(), methods);
function run(middleware, work, res = response()) {
  return new Promise((resolve, reject) => middleware({ method: "POST", route: { path: "/:conversationId/messages" },
    headers: { authorization: "SECRET" }, body: { body: "SECRET" }, originalUrl: "/SECRET?token=SECRET" }, res, () => {
    Promise.resolve().then(work).then(() => {
      res.writableFinished = true; res.emit("finish"); res.emit("close"); resolve();
    }, reject);
  }));
}

test("request timing separates acquisition/query time and releases the client", async () => {
  let time = 0;
  const logs = [], releases = [];
  const pool = { totalCount: 10, idleCount: 0, waitingCount: 3, async connect() {
    time += 25;
    return client({ async query(sql, values) {
      assert.equal(sql, "SECRET SQL"); assert.deepEqual(values, ["SECRET"]);
      time += 75; return { rows: [1] };
    }, release(error) { releases.push(error); } });
  } };
  const middleware = requestTiming({ pool, enabled: true, slowMs: 0, now: () => time, logger: line => logs.push(line) });
  await run(middleware, async () => assert.deepEqual(await timedQuery(pool, "messages.insert", "SECRET SQL", ["SECRET"]), { rows: [1] }));
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /SECRET/);
  const row = JSON.parse(logs[0]);
  assert.equal(row.durationMs, 100); assert.equal(row.dbWaitMs, 25); assert.equal(row.dbQueryMs, 75);
  assert.equal(row.dbCalls, 1); assert.equal(row.dbPending, 0);
  assert.deepEqual(row.pool, { total: 10, idle: 0, waiting: 3 });
  assert.deepEqual(row.dbOperations["messages.insert"], { calls: 1, errors: 0, waitMs: 25, queryMs: 75 });
  assert.deepEqual(releases, [undefined]);
});

test("concurrent requests keep separate query totals; slow logs are rate limited", async () => {
  let time = 0;
  const logs = [];
  const pool = { async connect() { return client({ async query() { await new Promise(r => setImmediate(r)); }, release() {} }); } };
  // Separate middleware instances allow both concurrent requests to emit a log.
  const make = () => requestTiming({ pool, enabled: true, slowMs: 0, now: () => time, logger: line => logs.push(JSON.parse(line)) });
  await Promise.all([run(make(), () => timedQuery(pool, "users.upsert", "SECRET")),
    run(make(), () => timedQuery(pool, "messages.insert", "SECRET"))]);
  assert.equal(logs.length, 2);
  assert.ok(logs.every(row => row.dbCalls === 1 && Object.keys(row.dbOperations).length === 1));
  assert.deepEqual(logs.map(row => Object.keys(row.dbOperations)[0]).sort(), ["messages.insert", "users.upsert"]);
  logs.length = 0;
  const middleware = make();
  await run(middleware, () => {});
  await run(middleware, () => {});
  time = 1000;
  await run(middleware, () => {});
  assert.equal(logs.length, 2); assert.equal(logs[1].suppressedSinceLastLog, 1);
});

test("database failures propagate unchanged and failed clients are discarded", async () => {
  for (const connectFails of [false, true]) {
    const error = new Error("SECRET"), logs = [], releases = [];
    const pool = { async connect() {
      if (connectFails) throw error;
      return client({ async query() { throw error; }, release(e) { releases.push(e); } });
    } };
    const middleware = requestTiming({ pool, enabled: true, slowMs: 0, logger: line => logs.push(JSON.parse(line)) });
    await run(middleware, async () => {
      await assert.rejects(timedQuery(pool, "messages.insert", "SECRET"), e => e === error);
    });
    assert.deepEqual(releases, connectFails ? [] : [error]);
    assert.equal(logs[0].dbOperations["messages.insert"].errors, 1);
    assert.equal(logs[0].dbPending, 0);
    assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
  }
});

test("aborted requests report outstanding connection waits without releasing clients early", async () => {
  let time = 0, connected, released = false;
  const logs = [], res = response();
  const pool = { connect: () => new Promise(resolve => { connected = resolve; }) };
  const middleware = requestTiming({ pool, enabled: true, now: () => time, logger: line => logs.push(JSON.parse(line)) });
  await run(middleware, async () => {
    const query = timedQuery(pool, "messages.insert", "SECRET");
    time = 80; res.emit("close");
    assert.equal(logs[0].aborted, true); assert.equal(logs[0].dbPending, 1); assert.equal(logs[0].dbWaitMs, 80);
    assert.equal(logs[0].status, null);
    assert.deepEqual(logs[0].dbOutstanding, [{ operation: "messages.insert", phase: "wait", elapsedMs: 80 }]);
    assert.equal(released, false);
    connected(client({ async query() {}, release() { released = true; } }));
    await query;
  }, res);
  assert.equal(released, true); assert.equal(logs.length, 1);
});

test("disabled diagnostics retain the bounded acquisition path and emit no timing logs", async () => {
  let calls = 0;
  const pool = { async connect() { return client({ query(sql, values) {
    calls++; assert.equal(sql, "SQL"); assert.deepEqual(values, [1]); return Promise.resolve(42);
  }, release() {} }); } };
  const middleware = requestTiming({ pool, enabled: false, logger() { assert.fail("diagnostics disabled"); } });
  await run(middleware, async () => assert.equal(await timedQuery(pool, "messages.insert", "SQL", [1]), 42));
  assert.equal(calls, 1);
});

test("a client error event rejects the request query and releases once", async () => {
  const failure = new Error("SECRET"), releases = [], logs = [];
  const connection = client({ query() {
    queueMicrotask(() => connection.emit("error", failure));
    return new Promise(() => {});
  }, release(error) { releases.push(error); } });
  const pool = { async connect() { return connection; } };
  const middleware = requestTiming({ pool, enabled: true, slowMs: 0, logger: line => logs.push(line) });
  await run(middleware, async () => {
    await assert.rejects(timedQuery(pool, "messages.insert", "SECRET"), error => error === failure);
  });
  assert.deepEqual(releases, [failure]);
  assert.equal(connection.listenerCount("error"), 0);
  assert.doesNotMatch(logs[0], /SECRET/);
});
