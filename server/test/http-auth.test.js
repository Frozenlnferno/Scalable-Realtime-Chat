import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";

// These HTTP tests never connect to PostgreSQL or Cognito.
process.env.DATABASE_URL = "postgresql://unused@127.0.0.1:1/unused";
const { createApp } = await import("../src/app.js");
const { createAuthenticator, authenticateRequest } = await import("../src/core/auth/authenticate.js");

async function serve(t, options) {
  const server = createApp({ timing: (_req, _res, next) => next(), ...options }).listen(0, "127.0.0.1");
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

test("message, history and direct-conversation routes authenticate exactly once", async t => {
  let verified = 0, synced = 0;
  const auth = createAuthenticator(async () => { verified++; return { cognitoSub: "u" }; }, async () => { synced++; return { id: "u" }; });
  const authenticate = async (req, _res, next) => {
    try { req.user = await auth("token"); next(); } catch (error) { next(error); }
  };
  const conversations = express.Router(), messages = express.Router();
  conversations.post("/direct", (_req, res) => res.json({ ok: true }));
  messages.post("/:conversationId/messages", (_req, res) => res.status(201).json({ ok: true }));
  messages.get("/:conversationId/messages", (_req, res) => res.json({ ok: true }));
  const url = await serve(t, { authenticate, conversations, messages });
  for (const [path, method, status] of [["/c/messages", "POST", 201], ["/c/messages", "GET", 200], ["/direct", "POST", 200]]) {
    assert.equal((await fetch(`${url}/api/conversations${path}`, { method })).status, status);
  }
  assert.equal(verified, 3); assert.equal(synced, 3);
});

test("missing or invalid credentials stay 401; database errors are not authentication errors", async t => {
  const url = await serve(t, { authenticate: authenticateRequest });
  for (const authorization of [undefined, "Basic token", "Bearer invalid"]) {
    const response = await fetch(`${url}/api/conversations/c/messages`, { headers: authorization ? { authorization } : {} });
    assert.equal(response.status, 401);
  }
  let synced = false;
  const invalid = createAuthenticator(async () => { throw new Error("SECRET"); }, () => { synced = true; });
  await assert.rejects(invalid("token"), error => error.status === 401 && !error.message.includes("SECRET"));
  assert.equal(synced, false);
  const failure = Object.assign(new Error("SECRET"), { status: 503, diagnosticCode: "db_overloaded" });
  const auth = createAuthenticator(async () => ({}), async () => { throw failure; });
  await assert.rejects(auth("token"), error => error === failure);
  const failedUrl = await serve(t, { authenticate: async (_req, _res, next) => { try { await auth("token"); } catch (error) { next(error); } } });
  const response = await fetch(`${failedUrl}/api/conversations/c/messages`);
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /SECRET/);
});
