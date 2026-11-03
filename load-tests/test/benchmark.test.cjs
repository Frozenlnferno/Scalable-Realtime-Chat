const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { makeCase, PROFILES, DEFAULT_TIMING } = require('../benchmark.cjs');
const { validateToken, prepare } = require('../setup.cjs');
const { executeRealtime, checkResponse } = require('../processor.cjs');
const { concurrency, distribution, buildSummary, renderSummary } = require('../report.cjs');
const { parseOptions, validateTarget } = require('../bench.cjs');
const { signInAccount } = require('../auth-worker.cjs');

test('SRP auth uses separate in-memory stores and handles additional challenges', async () => {
  const stores = [], inputs = [];
  const dependencies = {
    amplify: { Amplify: { configure: () => {} } },
    cognito: { cognitoUserPoolsTokenProvider: { setKeyValueStorage: store => stores.push(store) } },
    auth: { signIn: async input => { inputs.push(input); return { isSignedIn: true }; },
      fetchAuthSession: async () => ({ tokens: { idToken: { toString: () => 'test-token' } } }) },
  };
  assert.equal(await signInAccount({ username: 'one', password: 'SECRET' }, {}, dependencies), 'test-token');
  await stores[0].setItem('key', 'one');
  await signInAccount({ username: 'two', password: 'SECRET' }, {}, dependencies);
  assert.equal(await stores[1].getItem('key'), null);
  assert.equal(inputs[0].options.authFlowType, 'USER_SRP_AUTH');
  await assert.rejects(signInAccount({}, {}, { ...dependencies, auth: { signIn: async () => ({ isSignedIn: false }) } }), /additional_authentication_challenge/);
});

test('profiles, CLI validation, deterministic pairs and delays', () => {
  const fs = require('node:fs'), path = require('node:path'), YAML = require('yaml');
  for (const file of ['chat.yml', 'realtime.yml']) {
    const script = YAML.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
    assert.deepEqual(script.config.phases, PROFILES.small);
    assert.deepEqual(script.config.environments.load.phases, PROFILES.load);
  }
  assert.equal(PROFILES.load.reduce((n, p) => n + (p.arrivalCount ?? p.duration * p.arrivalRate), 0), 366);
  assert.deepEqual(parseOptions(['chat']), { scenario: 'chat', profile: 'small', tasks: 1, seed: 42, accountsFile: 'users.local.json', envFile: '.env.local' });
  assert.throws(() => parseOptions(['chat', '--profile', 'bad']));
  assert.throws(() => validateTarget('https://example.com/api/'));
  assert.throws(() => validateTarget('https://user:password@example.com'));
  const senders = new Set(), pairs = new Set();
  for (let i = 0; i < 1000; i++) {
    const a = makeCase(42, i, 4);
    assert.deepEqual(a, makeCase(42, i, 4));
    assert.notEqual(a.sender, a.recipient);
    assert.equal(a.delays.length, 5);
    assert.ok(a.delays.every(ms => ms >= 2000 && ms <= 8000));
    senders.add(a.sender); pairs.add([a.sender, a.recipient].sort().join(':'));
  }
  assert.equal(senders.size, 4); assert.equal(pairs.size, 6);
  assert.notDeepEqual(makeCase(42, 1, 4), makeCase(43, 1, 4));
});

const token = exp => `header.${Buffer.from(JSON.stringify({ sub: 'subject', token_use: 'id', aud: 'client', exp })).toString('base64url')}.signature`;
test('setup validates every account and prepares six conversations; failures are sanitized', async () => {
  const accounts = Array.from({ length: 4 }, (_, i) => ({ username: `user${i}`, password: 'SECRET_PASSWORD' }));
  const tokens = new Map(); let signIns = 0, calls = 0, pairs = 0;
  const signIn = async account => {
    signIns++;
    const jwt = token(Math.floor(Date.now() / 1000) + 3600).replace('header.', `header${signIns}.`);
    tokens.set(jwt, account.username); return jwt;
  };
  const fetchImpl = async (url, options) => {
    calls++;
    if (url.endsWith('/users')) return { status: 200, json: async () => ({ currentUser: { id: tokens.get(options.headers.Authorization.slice(7)) }, users: [] }) };
    pairs++; return { status: 200, json: async () => ({ conversation: { id: `conversation${pairs}` } }) };
  };
  const args = { accounts, cognito: { userPoolClientId: 'client' }, target: 'http://localhost', maxDurationMs: 600000, signIn, fetchImpl };
  const users = await prepare(args);
  assert.equal(users.length, 4); assert.equal(signIns, 4); assert.equal(calls, 10); assert.equal(pairs, 6);
  assert.throws(() => validateToken(token(1), Date.now()));
  assert.throws(() => validateToken(token(Math.floor(Date.now() / 1000) + 60), Date.now() + 660000));
  await assert.rejects(prepare({ ...args, signIn: async () => { throw new Error('SECRET_PASSWORD'); } }), error => !error.message.includes('SECRET_PASSWORD') && /No load/.test(error.message));
  await assert.rejects(prepare({ ...args, signIn: async () => { throw new Error('additional_authentication_challenge'); } }), /additional authentication challenge/);
  await assert.rejects(prepare({ ...args, fetchImpl: async () => ({ status: 401, json: async () => ({}) }) }), /No load/);
});

test('response validation rejects errors and HTML, accepts valid directory', () => {
  for (const response of [{ statusCode: 401, body: '{}' }, { statusCode: 200, body: '<html>SPA</html>' }, { statusCode: 200, body: '{}' }]) {
    checkResponse({ name: 'users' }, response, {}, {}, error => assert.ok(error));
  }
  checkResponse({ name: 'users' }, { statusCode: 200, body: '{"currentUser":{"id":"u"},"users":[]}' }, {}, {}, assert.ifError);
});

class ManualClock {
  time = 0; next = 0; timers = new Map();
  now = () => this.time;
  setTimeout = (fn, ms) => { const id = ++this.next; this.timers.set(id, { fn, at: this.time + ms }); return id; };
  clearTimeout = id => this.timers.delete(id);
  async drive(promise) {
    let settled = false, result, error;
    promise.then(value => { settled = true; result = value; }, caught => { settled = true; error = caught; });
    for (let step = 0; step < 1000 && !settled; step++) {
      await new Promise(resolve => setImmediate(resolve));
      if (settled) break;
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      assert.ok(next, 'Pending scenario has a timer');
      this.time = next[1].at;
      this.timers.delete(next[0]); next[1].fn();
    }
    assert.ok(settled, 'Scenario settled');
    assert.equal(this.timers.size, 0, 'All scenario timers were released');
    if (error) throw error;
    return result;
  }
}

function realtimeFixture(mode = 'ok', overrides = {}) {
  const clock = new ManualClock(), sockets = [], metrics = [], requests = [];
  const config = { seed: 42, runId: 'fixture', target: 'http://localhost', timing: { ...DEFAULT_TIMING, delayMinMs: 0, delayMaxMs: 0, ...overrides },
    users: Array.from({ length: 4 }, (_, i) => ({ id: `u${i}`, token: `fake${i}` })) };
  const pair = makeCase(42, 0, 4, config.timing);
  const connect = (_url, options) => {
    const socket = new EventEmitter(); socket.connected = false;
    assert.equal(options.reconnection, false);
    socket.connect = () => queueMicrotask(() => {
      if (mode === 'connect-error' && sockets.indexOf(socket) === 1) return socket.emit('connect_error', new Error('SECRET'));
      socket.connected = true; socket.emit('connect');
    });
    socket.disconnect = () => { socket.connected = false; socket.emit('disconnect'); };
    socket.user = options.auth.token;
    sockets.push(socket); return socket;
  };
  let number = 0;
  const fetchImpl = async (url, options) => {
    requests.push(url);
    let body;
    if (url.endsWith('/users')) body = { currentUser: { id: `u${pair.sender}` }, users: [] };
    else if (url.endsWith('/direct')) body = { conversation: { id: 'conversation' } };
    else if (!options.body) body = { messages: [] };
    else {
      if (mode === 'http-error') return { status: 503, json: async () => ({}) };
      const message = { id: `m${++number}`, senderId: `u${pair.sender}`, conversationId: 'conversation', body: JSON.parse(options.body).body };
      // The sender is socket 0, recipient socket 1. Emit before HTTP resolves.
      for (let i = 0; i < 2; i++) {
        sockets[i].emit('message:created', { ...message, body: 'unrelated session' });
        if ((mode === 'drop' && i === 1) || (mode === 'no-echo' && i === 0)) continue;
        sockets[i].emit('message:created', message);
      }
      if (number === 1 && mode === 'idle-disconnect') clock.setTimeout(() => sockets[1].disconnect(), 30000);
      if (number === 1 && mode === 'late-duplicate') clock.setTimeout(() => sockets[1].emit('message:created', message), 40000);
      body = { message: mode === 'mismatch' ? { ...message, id: 'wrong' } : message };
    }
    return { status: url.endsWith('/messages') && options.body ? 201 : 200, json: async () => body };
  };
  const run = () => executeRealtime({ vars: { caseIndex: 0 } }, { emit: (...args) => metrics.push(args) }, { config, clock, connect, fetchImpl });
  return { clock, sockets, metrics, requests, run };
}

test('real-time sends five messages, matches events preceding HTTP, confirms both roles and holds a minute', async () => {
  const f = realtimeFixture();
  await f.clock.drive(f.run());
  assert.equal(f.clock.time, 60000);
  assert.equal(f.requests.length, 8);
  assert.equal(f.metrics.filter(([, name]) => name === 'chat.messages_received').length, 5);
  assert.equal(f.metrics.filter(([, name]) => name === 'chat.sender_echoes').length, 5);
  assert.ok(f.sockets.every(s => !s.connected && s.eventNames().length === 0));
});

for (const [mode, reason] of [['http-error', 'unexpected_http_503'], ['drop', 'delivery_timeout'], ['no-echo', 'echo_timeout'],
  ['idle-disconnect', 'socket_disconnected'], ['late-duplicate', 'duplicate_delivery'], ['mismatch', 'message_mismatch'], ['connect-error', 'socket_connect_failed']]) {
  test(`real-time fails on ${mode}, including idle-time failures, and cleans up`, async () => {
    const f = realtimeFixture(mode);
    await assert.rejects(f.clock.drive(f.run()), new RegExp(reason));
    assert.ok(f.sockets.every(s => !s.connected && s.eventNames().length === 0));
    assert.equal(f.metrics.filter(([, name]) => name === 'chat.failures').length, 1);
    if (mode === 'drop') assert.equal(f.metrics.filter(([, name]) => name === 'chat.sender_echoes').length, 1);
    if (mode === 'no-echo') assert.equal(f.metrics.filter(([, name]) => name === 'chat.messages_received').length, 1);
  });
}

test('overall deadline interrupts an otherwise healthy session', async () => {
  const f = realtimeFixture('ok', { deadlineMs: 1000 });
  await assert.rejects(f.clock.drive(f.run()), /session_deadline/);
});

test('merge concurrent worker lifecycles and do not sum their independent peaks', () => {
  const rows = [
    { at: 1, type: 'session_open', session: 'a' }, { at: 2, type: 'socket_open', socket: 'a' },
    { at: 3, type: 'session_open', session: 'b' }, { at: 4, type: 'socket_open', socket: 'b' },
    { at: 5, type: 'socket_close', socket: 'a' }, { at: 6, type: 'session_close', session: 'a' },
    { at: 7, type: 'socket_close', socket: 'b' }, { at: 8, type: 'session_close', session: 'b' },
  ];
  assert.deepEqual({ ...concurrency(rows), timeline: undefined }, { peakSessions: 2, peakSockets: 2, valid: true, timeline: undefined });
  assert.equal(concurrency(rows.slice(0, -1)).valid, false);
  assert.equal(distribution([1, 2, 3, 4, 5]).p95, 5);
});

test('summary fails empty or rejected runs and never includes credentials', () => {
  const metadata = { scenario: 'realtime', profile: 'small', expectedSessions: 4, tasks: 3, accountCount: 4, seed: 42 };
  const summary = buildSummary(metadata, {}, [], 1);
  assert.equal(summary.passed, false);
  assert.ok(summary.checks.some(c => !c.passed && c.name.includes('recipient')));
  assert.match(renderSummary(summary), /FAIL/);
  assert.doesNotMatch(JSON.stringify(summary), /SECRET_PASSWORD/);
});
