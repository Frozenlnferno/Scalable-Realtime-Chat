import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Server } from "socket.io";
import { io as connect } from "socket.io-client";

import { configureSocketAdapter } from "../src/core/socket/redis.adapter.js";
import { emitMessageCreated, setSocketServer } from "../src/core/socket/socket.events.js";

function captureLogs() {
  const lines = [];
  return { lines, info: (line) => lines.push(line), warn: (line) => lines.push(line) };
}

async function startServer(t, options) {
  const httpServer = createServer();
  const io = new Server(httpServer, { serveClient: false });
  t.after(async () => {
    await io.close();
    // A Redis reconnect timer left running would keep the test process alive.
    const adapter = io.of("/").adapter;
    if (adapter.pubClient) {
      await delay(0);
      assert.equal(adapter.pubClient.status, "end");
      assert.equal(adapter.subClient.status, "end");
    }
  });
  await configureSocketAdapter(io, options);
  // Test-only identities isolate adapter behavior from Cognito and PostgreSQL.
  io.on("connection", async (socket) => {
    await socket.join(`user:${socket.handshake.auth.userId}`);
    socket.emit("test:ready");
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  return { io, url: `http://127.0.0.1:${httpServer.address().port}` };
}

async function client(t, server, userId) {
  const socket = connect(server.url, {
    auth: { userId }, autoConnect: false, reconnection: false, timeout: 2_000,
  });
  const messages = [];
  socket.on("message:created", (message) => messages.push(message));
  t.after(() => socket.disconnect());
  const ready = new Promise((resolve, reject) => {
    socket.once("test:ready", resolve);
    socket.once("connect_error", reject);
  });
  socket.connect();
  await ready;
  return { socket, messages };
}

async function expectMessage(origin, receivers, body) {
  const message = { id: randomUUID(), conversationId: "conversation", senderId: "alice", body };
  const delivery = receivers.map(({ socket }) => once(socket, "message:created"));
  setSocketServer(origin.io);
  emitMessageCreated(message, ["alice", "bob"]);
  const events = await Promise.all(delivery);
  for (const [received] of events) assert.deepEqual(received, message);
  await delay(100);
  for (const receiver of receivers) {
    assert.equal(receiver.messages.filter((item) => item.id === message.id).length, 1);
  }
}

test("unset REDIS_URL preserves local user-room delivery", { timeout: 5_000 }, async (t) => {
  const logger = captureLogs();
  const server = await startServer(t, { redisUrl: "", logger });
  const alice = await client(t, server, "alice");
  const bob = await client(t, server, "bob");
  const other = await client(t, server, "other");
  await expectMessage(server, [alice, bob], "Local delivery");
  assert.deepEqual(other.messages, []);
  assert.match(logger.lines.join("\n"), /in-memory adapter/);
});

test("malformed Redis configuration fails without leaking credentials", async (t) => {
  const logger = captureLogs();
  await assert.rejects(
    startServer(t, { redisUrl: "https://secret-user:secret-password@invalid.example", logger }),
    (error) => {
      assert.match(error.message, /Unable to initialize Socket.IO Redis Pub\/Sub/);
      assert.doesNotMatch(error.stack + logger.lines.join("\n"), /secret-user|secret-password|invalid\.example/);
      return true;
    },
  );
});

test("unreachable Redis fails after 10 seconds and stops retrying", { timeout: 15_000 }, async (t) => {
  // Obtain an unused local port, then close it to exercise refused connections.
  const reserved = createTcpServer();
  reserved.listen(0, "127.0.0.1");
  await once(reserved, "listening");
  const port = reserved.address().port;
  await new Promise((resolve) => reserved.close(resolve));
  const logger = captureLogs();
  const started = Date.now();
  await assert.rejects(
    startServer(t, { redisUrl: `redis://secret-user:secret-password@127.0.0.1:${port}`, logger }),
    (error) => {
      assert.match(error.message, /within 10 seconds/);
      assert.doesNotMatch(error.stack + logger.lines.join("\n"), /secret-user|secret-password|redis:\/\//);
      return true;
    },
  );
  assert.ok(Date.now() - started >= 9_500, "startup must allow the configured connection deadline");
  const count = logger.lines.length;
  await delay(300);
  assert.equal(logger.lines.length, count, "no reconnect activity should remain after failure");
});

test("Redis shares user-room messages across two servers", {
  skip: !process.env.REDIS_TEST_URL && "Set REDIS_TEST_URL to enable the Redis integration test",
  timeout: 30_000,
}, async (t) => {
  const options = {
    redisUrl: process.env.REDIS_TEST_URL,
    keyPrefix: `${process.env.REDIS_KEY_PREFIX || "chat:socket.io"}:test:${randomUUID()}`,
    logger: captureLogs(),
  };
  const first = await startServer(t, options);
  const second = await startServer(t, options);
  const alice = await client(t, first, "alice");
  const bob = await client(t, second, "bob");
  const otherOnFirst = await client(t, first, "other");
  const otherOnSecond = await client(t, second, "other");
  await expectMessage(first, [alice, bob], "First to second");
  await expectMessage(second, [alice, bob], "Second to first");
  assert.deepEqual(otherOnFirst.messages, []);
  assert.deepEqual(otherOnSecond.messages, []);
});
