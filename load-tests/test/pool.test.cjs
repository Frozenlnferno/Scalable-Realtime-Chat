const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { TIMING, THRESHOLDS, VERSION, selectAccounts, schedule, partition } = require('../pool.cjs');
const { parseOptions, runBenchmark } = require('../bench.cjs');
const { provision, backoff, provisioningReason } = require('../provision.cjs');
const { prepare, validateToken } = require('../setup.cjs');
const { signInAccount, authFailureCode } = require('../auth-worker.cjs');
const { validateTarget } = require('../pool-runner.cjs');
const { createWorker } = require('../pool-worker.cjs');
const { runController } = require('../pool-controller.cjs');
const { compare } = require('../compare.cjs');
const { summarizePool } = require('../pool-report.cjs');
const { startFixture } = require('./fixtures.cjs');

test('CLI requires explicit load size; seeded pool selection and complete disjoint worker pairs', () => {
  assert.throws(() => parseOptions(['realtime', '--profile', 'load']), /clients/);
  for (const clients of ['1', '3', '-2', 'NaN']) assert.throws(() => parseOptions(['realtime', '--clients', clients]));
  assert.equal(parseOptions(['realtime']).clients, 4);
  assert.throws(() => parseOptions(['realtime', '--workload', 'sessions']));
  assert.throws(() => parseOptions(['chat']));
  assert.throws(() => parseOptions(['realtime', '--profile', 'bad']));
  assert.throws(() => validateTarget('https://example.com/api/'));
  assert.throws(() => validateTarget('https://user:password@example.com'));
  assert.equal(parseOptions(['realtime', '--accounts', 'users.local.json']).accountsFile, 'users.local.json');
  const accounts = Array.from({ length: 20 }, (_, i) => ({ username: `user${i}`, password: 'SECRET' }));
  const chosen = selectAccounts(accounts, 10, 42);
  assert.deepEqual(chosen, selectAccounts([...accounts].reverse(), 10, 42));
  assert.equal(new Set(chosen).size, 10);
  assert.throws(() => selectAccounts(accounts, 22, 42));
  const groups = partition(chosen, 4);
  assert.equal(groups.length, 4);
  assert.equal(new Set(groups.flat()).size, 10);
  for (const group of groups) for (const i of group) assert.ok(group.includes(i ^ 1));
  const slots = schedule(42, 0, TIMING);
  assert.deepEqual(slots, schedule(42, 0, TIMING));
  assert.notDeepEqual(slots, schedule(42, 1, TIMING));
  assert.ok(slots.slice(1).every((n, i) => n - slots[i] >= 3000 && n - slots[i] <= 5000));
});

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

test('provision resumes permanent-password failure and preserves existing credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-users-'));
  const out = path.join(dir, 'users.local.json'), commands = [];
  class Command { constructor(input) { this.input = input; } }
  class Create extends Command {} class Password extends Command {}
  let fail = true;
  const deps = { sdk: { AdminCreateUserCommand: Create, AdminSetUserPasswordCommand: Password }, client: {
    async send(command) { commands.push(command); if (command instanceof Password && fail) { fail = false; throw new Error('SECRET'); } },
  } };
  const options = { count: 12, emailBase: 'mail@example.com', poolId: 'us-east-1_pool', out, concurrency: 4 };
  await assert.rejects(provision(options, deps), /resume/);
  const journal = JSON.parse(fs.readFileSync(`${out}.progress.local.json`));
  const password = journal.accounts[0].password;
  assert.equal(journal.accounts[0].status, 'created');
  assert.equal(await provision(options, deps), 12);
  const saved = fs.readFileSync(out, 'utf8');
  assert.equal(JSON.parse(saved)[0].password, password);
  assert.equal(commands.filter(c => c instanceof Create).length, 12);
  assert.ok(commands.filter(c => c instanceof Create).every(c => c.input.MessageAction === 'SUPPRESS'));
  assert.ok(commands.filter(c => c instanceof Password).every(c => c.input.Permanent));
  await provision({ ...options, count: 2 }, deps);
  assert.equal(fs.readFileSync(out, 'utf8'), saved);
  await assert.rejects(provision({ ...options, poolId: 'other_pool' }, deps));
  assert.equal(fs.readFileSync(out, 'utf8'), saved);
  let attempts = 0; const pauses = [];
  assert.equal(await backoff(async () => { if (++attempts < 3) throw { name: 'TooManyRequestsException' }; return 'ok'; }, async ms => pauses.push(ms)), 'ok');
  assert.equal(pauses.length, 2);
});

test('provisioning errors identify missing credentials and denied operations without printing remote secrets', async () => {
  for (const [name, expected] of [['CredentialsProviderError', /AWS credentials/], ['AccessDeniedException', /permission/], ['ExpiredTokenException', /expired/]]) {
    const error = Object.assign(new Error('SECRET_PASSWORD SECRET_TOKEN'), { name });
    const reason = provisioningReason(error);
    assert.match(reason, expected); assert.doesNotMatch(reason, /SECRET/);
  }
  assert.doesNotMatch(provisioningReason(new SyntaxError('SECRET_PASSWORD')), /SECRET/);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-auth-error-')), 'users.local.json');
  class Command { constructor(input) { this.input = input; } }
  await assert.rejects(provision({ count: 2, emailBase: 'mail@example.com', poolId: 'us-east-1_pool', out }, {
    sdk: { AdminCreateUserCommand: Command },
    client: { send: async () => { throw Object.assign(new Error('SECRET_TOKEN'), { name: 'CredentialsProviderError' }); } },
  }), error => /AdminCreateUser:.*AWS credentials.*resume/.test(error.message) && !error.message.includes('SECRET'));
  assert.ok(fs.existsSync(`${out}.progress.local.json`));
});

test('pool preparation uses four auth workers and only one conversation/history per pair; expiry rechecked', async () => {
  let active = 0, peak = 0, auth = 0, conversations = 0, histories = 0;
  const accounts = Array.from({ length: 10 }, (_, i) => ({ username: `u${i}`, password: 'SECRET' }));
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const args = { accounts, cognito: { userPoolClientId: 'client' }, target: 'http://local', maxDurationMs: 1000,
    signIn: async account => { active++; peak = Math.max(peak, active); auth++; await new Promise(r => setImmediate(r)); active--; return `h.${Buffer.from(JSON.stringify({ token_use: 'id', aud: 'client', sub: account.username, exp })).toString('base64url')}.s`; },
    fetchImpl: async (url, options) => {
      let data;
      if (url.endsWith('/users')) data = { currentUser: { id: JSON.parse(Buffer.from(options.headers.Authorization.split('.')[1], 'base64url')).sub }, users: [] };
      else if (url.endsWith('/direct')) data = { conversation: { id: `c${++conversations}` } };
      else { histories++; data = { messages: [] }; }
      return { status: 200, json: async () => data };
    } };
  const users = await prepare(args);
  assert.equal(auth, 10); assert.equal(peak, 4); assert.equal(conversations, 5); assert.equal(histories, 5);
  assert.equal(users[0].conversationId, users[1].conversationId);
  await assert.rejects(prepare({ ...args, signIn: async () => { throw new Error('SECRET_PASSWORD'); } }), error => /No load/.test(error.message) && !error.message.includes('SECRET_PASSWORD'));
  await assert.rejects(prepare({ ...args, signIn: async () => { throw new Error('additional_authentication_challenge'); } }), /additional authentication challenge/);
  for (const response of [{ status: 401, data: {} }, { status: 200, data: {} }, { status: 200, data: null }]) {
    await assert.rejects(prepare({ ...args, fetchImpl: async () => ({ status: response.status, json: async () => response.data }) }), /No load/);
  }
  assert.throws(() => validateToken('not-a-token', Date.now()), /invalid/);
  const token = `h.${Buffer.from(JSON.stringify({ sub: 'subject', token_use: 'id', aud: 'client', exp })).toString('base64url')}.s`;
  assert.throws(() => validateToken(token, Date.now(), { userPoolClientId: 'other-client' }), /invalid/);
  for (const code of ['TooManyRequestsException', 'NotAuthorizedException', 'NetworkError']) {
    assert.equal(authFailureCode({ name: code, message: 'SECRET' }), code);
    await assert.rejects(prepare({ ...args, signIn: async () => { throw new Error(code); } }),
      error => error.message.includes(`Cognito sign-in: ${code}`) && !error.message.includes('SECRET'));
  }
  assert.equal(authFailureCode(new Error('SECRET')), 'cognito_sign_in_failed');
  await assert.rejects(prepare({ ...args, fetchImpl: async () => ({ status: 429 }) }), /GET \/api\/users preflight: HTTP 429/);
  await assert.rejects(prepare({ ...args, fetchImpl: async () => { throw Object.assign(new Error('SECRET'), { name: 'TimeoutError' }); } }),
    error => /GET \/api\/users preflight: TimeoutError/.test(error.message) && !error.message.includes('SECRET'));
  const realNow = Date.now;
  try {
    let current = realNow(); Date.now = () => current;
    await assert.rejects(prepare({ ...args, fetchImpl: async (...a) => {
      const result = await args.fetchImpl(...a);
      if (a[0].endsWith('/messages')) current += 3600000;
      return result;
    } }), /expires/);
  } finally { Date.now = realNow; }
});

class Clock {
  time = 0; next = 0; timers = new Map(); lateness = 0;
  now = () => this.time;
  setTimeout = (fn, ms) => { const id = ++this.next; this.timers.set(id, { at: this.time + Math.max(0, ms), fn }); return id; };
  clearTimeout = id => this.timers.delete(id);
  async drive(promise) {
    let done = false, failure;
    promise.then(() => { done = true; }, error => { done = true; failure = error; });
    for (let i = 0; !done && i < 10000; i++) {
      await new Promise(r => setImmediate(r));
      if (done) break;
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      assert.ok(next, 'operation must own a timer');
      this.time = Math.max(this.time, next[1].at) + this.lateness;
      this.timers.delete(next[0]); next[1].fn();
    }
    assert.ok(done); if (failure) throw failure;
  }
}
async function workerFixture(mode, overrides = {}) {
  const clock = new Clock(), rows = [], sockets = [], requests = [];
  const timing = { ...TIMING, rampMs: 200, measureMs: 1000, intervalMinMs: 100, intervalMaxMs: 150, timeoutMs: 300, drainMs: 300, ...overrides };
  const config = { timing, workers: 1, seed: 42, runId: 'test', target: 'http://local', users: [{ id: 'u0', token: 'SECRET0', conversationId: 'c' }, { id: 'u1', token: 'SECRET1', conversationId: 'c' }] };
  const connect = (_, options) => {
    assert.equal(options.autoConnect, false); assert.equal(options.reconnection, false);
    const socket = new EventEmitter(); const index = sockets.length;
    let connectionTimer;
    socket.connect = () => { connectionTimer = clock.setTimeout(() => socket.emit(mode === 'connect-fail' ? 'connect_error' : 'connect'), mode === 'slow-connect' ? 500 : 1); };
    socket.disconnect = () => { clock.clearTimeout(connectionTimer); socket.emit('disconnect'); };
    sockets.push(socket); socket.index = index; return socket;
  };
  let inflight = 0, peak = 0;
  const fetchImpl = async (url, options) => {
    assert.ok(clock.time >= 200, 'no messaging during ramp');
    inflight++; peak = Math.max(peak, inflight); requests.push(clock.time);
    const index = Number(options.headers.Authorization.slice(-1));
    const message = { id: `m${requests.length}`, senderId: `u${index}`, conversationId: 'c', body: JSON.parse(options.body).body };
    for (const socket of sockets) {
      socket.emit('message:created', { ...message, conversationId: 'other' });
      if (mode === 'drop' && socket.index !== index || mode === 'no-echo' && socket.index === index) continue;
      socket.emit('message:created', message);
      if (mode === 'duplicate') socket.emit('message:created', message);
    }
    if (mode === 'disconnect' && requests.length === 1) sockets[0].disconnect();
    if (mode === 'overlap' || mode === 'limit') await new Promise(resolve => clock.setTimeout(resolve, 250));
    inflight--;
    if (mode === 'ambiguous') throw new Error('SECRET');
    if (mode === 'network-error') throw Object.assign(new Error('SECRET'), { cause: { code: 'ECONNRESET' } });
    if (mode === 'hang') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    if (mode === 'slow-headers') await new Promise(resolve => clock.setTimeout(resolve, 80));
    return { status: 201, json: async () => {
      if (mode === 'slow-body') await new Promise(resolve => clock.setTimeout(resolve, 80));
      if (mode === 'body-hang') await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('SECRET')), { once: true }));
      if (mode === 'invalid-json') throw new SyntaxError('SECRET');
      return { message: mode === 'mismatch' ? { id: 'wrong' } : message };
    } };
  };
  const worker = await createWorker(config, [0, 1], row => rows.push(row), { clock, connect, fetchImpl });
  const run = async () => {
    try { await worker.ramp(0); if (mode === 'late') clock.lateness = 101; if (mode === 'end-late') clock.lateness = 50; await worker.measure(200); }
    finally { await worker.close(); }
  };
  return { clock, rows, sockets, requests, run, peak: () => peak, timing };
}

test('fractional timer truncation cannot start sends or socket cleanup before their deadlines', async () => {
  const f = await workerFixture('ok', { measureMs: 1000.5 });
  const setTimer = f.clock.setTimeout;
  f.clock.setTimeout = (fn, ms) => setTimer(fn, Math.max(1, Math.trunc(ms)));
  await f.clock.drive(f.run());
  const start = f.rows.find(r => r.type === 'measurement_start');
  assert.ok(f.rows.find(r => r.type === 'measurement_end').at >= start.end);
  assert.ok(f.rows.filter(r => r.type === 'socket_close').every(r => r.at >= start.end));
  assert.ok(f.rows.filter(r => r.type === 'message').every(r => r.at >= r.scheduledAt));
});

for (const mode of ['ok', 'overlap', 'drop', 'no-echo', 'ambiguous', 'duplicate', 'disconnect', 'mismatch', 'hang', 'slow-headers', 'slow-body', 'body-hang', 'invalid-json', 'network-error', 'late', 'end-late', 'limit', 'connect-fail', 'slow-connect']) {
  test(`clock-controlled persistent worker: ${mode}`, async () => {
    const f = await workerFixture(mode, mode === 'limit' ? { intervalMinMs: 1, intervalMaxMs: 2 } : {});
    if (mode === 'connect-fail' || mode === 'slow-connect') await assert.rejects(f.clock.drive(f.run()), /socket_connect_failed/);
    else await f.clock.drive(f.run());
    const messages = f.rows.filter(r => r.type === 'message');
    if (mode === 'ok') {
      assert.ok(messages.length > 10);
      assert.ok(messages.every(r => r.posted && r.recipient && r.echo));
      assert.equal(f.clock.time, 1200);
      assert.ok(f.rows.filter(r => r.type === 'socket_close').every(r => r.at >= f.rows.find(r => r.type === 'measurement_end').at));
    }
    if (mode === 'overlap') assert.ok(f.peak() > 2, 'sends overlap independently of responses');
    if (mode === 'drop') assert.ok(messages.every(r => r.posted && !r.recipient && r.echo));
    if (mode === 'no-echo') assert.ok(messages.every(r => r.posted && r.recipient && !r.echo));
    if (mode === 'ambiguous' || mode === 'hang') assert.ok(messages.every(r => r.ambiguous && !r.posted && r.recipientObserved && r.echoObserved));
    if (mode === 'hang') assert.ok(messages.every(r => r.httpError === 'headers_deadline' && r.httpState === 'awaiting_headers'));
    if (mode === 'slow-headers') assert.ok(messages.every(r => r.headersMs === 80 && r.bodyMs === 0 && r.apiMs === 80));
    if (mode === 'slow-body') assert.ok(messages.every(r => r.headersMs === 0 && r.bodyMs === 80 && r.apiMs === 80));
    if (mode === 'body-hang') assert.ok(messages.every(r => r.httpError === 'body_deadline' && r.httpState === 'reading_body' && r.status === 201));
    if (mode === 'invalid-json') assert.ok(messages.every(r => r.httpError === 'invalid_json' && r.status === 201 && !r.posted));
    if (mode === 'network-error') assert.ok(messages.every(r => r.httpError === 'ECONNRESET' && !r.posted));
    if (mode === 'mismatch') assert.ok(messages.every(r => r.posted && !r.recipient && !r.echo));
    if (mode === 'duplicate') assert.ok(f.rows.some(r => r.type === 'duplicate'));
    if (mode === 'disconnect') assert.ok(f.rows.some(r => r.type === 'disconnect'));
    if (mode === 'late') {
      assert.ok(messages.some(r => r.missed && !r.attempted));
      assert.ok(messages.every(r => !r.attempted || r.lag <= f.timing.lateMs));
    }
    if (mode === 'end-late') assert.ok(f.requests.every(at => at < 1200), 'never dispatch after measurement ends');
    if (mode === 'limit') assert.ok(messages.some(r => r.limit));
    assert.equal(f.clock.timers.size, 0);
    assert.ok(f.sockets.every(s => s.eventNames().length === 0));
    assert.doesNotMatch(JSON.stringify(f.rows), /SECRET/);
  });
}

for (const mode of ['ok', 'drop', 'http-error', 'connect-error']) {
  test(`real Artillery pool / ${mode}: reports, aggregation and exit criteria`, { timeout: 120000 }, async t => {
    const fixture = await startFixture(mode); t.after(() => fixture.close());
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-integration-'));
    const envFile = path.join(root, 'fixture.env'); fs.writeFileSync(envFile, `CHAT_API_URL=${fixture.target}\n`);
    const result = await runBenchmark({ scenario: 'realtime', profile: 'small', clients: 4, tasks: 1, seed: 42, envFile }, {
      users: fixture.users, resultsRoot: root, quiet: !process.env.BENCH_TEST_VERBOSE,
      timing: { rampMs: 100, graceMs: 600, measureMs: 1500, intervalMinMs: 200, intervalMaxMs: 300, timeoutMs: 500, drainMs: 500 },
    });
    assert.equal(result.summary.passed, mode === 'ok', JSON.stringify(result.summary.checks));
    assert.equal(result.exitCode, mode === 'ok' ? 0 : 1);
    assert.equal(result.summary.metadata.workers, 2);
    assert.equal(result.summary.concurrency.peak, mode === 'connect-error' ? 0 : 4);
    if (mode !== 'connect-error') assert.equal(Object.keys(result.summary.generator.workers).length, 2);
    else assert.equal(result.summary.windows.whole.attempted, 0);
    assert.equal(fixture.connected(), 0);
    if (mode === 'ok') {
      assert.equal(result.summary.windows.whole.headersMs.count, result.summary.windows.whole.attempted);
      assert.equal(result.summary.windows.whole.bodyMs.count, result.summary.windows.whole.posted);
      assert.equal(Object.keys(result.summary.httpDiagnostics.workers).length, 2);
    }
    for (const name of ['artillery.json', 'summary.json', 'summary.md', 'metadata.json']) {
      assert.doesNotMatch(fs.readFileSync(path.join(result.resultDir, name), 'utf8'), /fixture[0-3]/);
    }
  });
}

test('comparison rejects legacy, mismatched settings and duplicate repetitions; uses confirmed sustainable rates', () => {
  const make = (tasks, clients, id, passed = true) => ({ metadata: { schemaVersion: 3, workloadVersion: VERSION, runId: id, tasks, clients, profile: 'load', seed: 42, timing: TIMING,
    thresholds: THRESHOLDS, workers: 4, workersRequested: 4, nodeVersion: 'v22', runnerPlatform: 'win', runnerCpuCount: 4, target: 'http://local', socketTarget: 'http://local', socketPath: '/socket.io',
    sourceFingerprint: 'source', gitRevision: 'rev', poolFingerprint: 'pool', accountFingerprint: `a${clients}`, pairFingerprint: `p${clients}`, scheduleFingerprint: `s${clients}` }, passed, capacityEligible: passed,
    windows: { whole: { rates: { confirmed: clients / 4 } } } });
  const runs = [1, 2, 3].flatMap(i => [make(1, 500, `a${i}`), make(3, 1000, `b${i}`)]);
  const result = compare([...runs, make(3, 1500, 'fail', false)], 'capacity');
  assert.equal(result.ratios[0].confirmedThroughputRatio, 2);
  assert.equal(result.capacities[1].higherFailingLevels[0].clients, 1500);
  assert.equal(compare(runs.slice(0, 2), 'capacity').ratios.length, 0);
  assert.throws(() => compare(runs, 'fixed'), /Incompatible/);
  assert.throws(() => compare([runs[0], runs[0]], 'fixed'), /Repeated/);
  assert.throws(() => compare([{ metadata: {} }, runs[0]], 'capacity'), /Legacy/);
  const changed = structuredClone(runs[0]); changed.metadata.thresholds.apiP95Ms++;
  assert.throws(() => compare([runs[0], changed], 'capacity'), /Incompatible/);
});

test('controller waits for every worker after ramp, enforces grace, and always terminates workers', async () => {
  for (const late of [false, true]) {
    const clock = new Clock(), workers = [], starts = [], failures = [];
    const timing = { ...TIMING, rampMs: 200, graceMs: 150, measureMs: 1000, drainMs: 100 };
    class Worker extends EventEmitter {
      constructor(_, { workerData }) {
        super(); this.index = workerData.workerIndex; this.timers = [];
        workers.push(this); queueMicrotask(() => this.emit('message', { type: 'booted' }));
      }
      postMessage(message) {
        if (message.type === 'ramp') this.timers.push(clock.setTimeout(() => this.emit('message', { type: 'ready' }),
          message.at + timing.rampMs + (this.index ? late ? 200 : 100 : 0) - clock.now()));
        if (message.type === 'start') {
          starts.push(message.at);
          this.timers.push(clock.setTimeout(() => this.emit('message', { type: 'done' }), message.at + timing.measureMs - clock.now()));
        }
      }
      async terminate() { this.terminated = true; for (const timer of this.timers) clock.clearTimeout(timer); }
    }
    const run = runController({ users: [{}, {}, {}, {}], workers: 2, timing }, { emit() {} }, { Worker, clock, onFailure: stage => failures.push(stage) });
    if (late) {
      await assert.rejects(clock.drive(run), /pool_controller_failed/);
      assert.equal(starts.length, 0); assert.deepEqual(failures, ['ramp']);
    } else {
      await clock.drive(run); assert.deepEqual(starts, [500, 500]);
    }
    assert.ok(workers.every(w => w.terminated)); assert.equal(clock.timers.size, 0);
  }
});

test('streamed summary includes drain outcomes in scheduled cohorts and rejects overloaded workers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-report-'));
  const metadata = { clients: 2, workers: 1, seed: 42, timing: TIMING, thresholds: THRESHOLDS };
  const start = 1000, end = start + TIMING.measureMs;
  const rows = [0, 1].map(index => ({ type: 'socket_open', index, at: 0 }));
  rows.push({ type: 'measurement_start', worker: 0, at: start, start, end });
  for (let index = 0; index < 2; index++) for (const [slot, offset] of schedule(42, index, TIMING).entries()) {
    const at = start + offset;
    rows.push({ type: 'message', index, worker: 0, key: `${index}/${slot}`, scheduledAt: at,
      attempted: true, posted: true, apiMs: offset >= 60000 ? 510 : 1, headersMs: 1, bodyMs: 2, status: 201, lag: 51,
      recipientObserved: true, echoObserved: true, recipient: { ms: 100, at: end + 1 }, echo: { ms: 100, at: end + 1 }, at: end + 1 });
  }
  rows.push({ type: 'health', worker: 0, at: end + 2 });
  for (let index = 0; index < 2; index++) rows.push({ type: 'socket_close', index, at: end + 3 });
  fs.writeFileSync(path.join(dir, 'worker.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
  const summary = await summarizePool(metadata, { aggregate: { counters: { 'vusers.completed': 1 } } }, dir, 0);
  assert.equal(summary.windows.whole.confirmed, summary.windows.whole.planned);
  assert.equal(summary.windows.settled.confirmed, summary.windows.settled.planned);
  assert.equal(summary.windows.whole.receiptTimeConfirmations, 0);
  assert.equal(summary.windows.settled.durationSeconds, 240);
  assert.equal(summary.windows.whole.headersMs.p95, 1);
  assert.equal(summary.windows.whole.bodyMs.p95, 2);
  assert.equal(summary.httpDiagnostics.workers[0].statuses[201], summary.windows.whole.posted);
  assert.equal(summary.capacityEligible, false);
  assert.ok(summary.checks.some(c => c.name.includes('Generator') && !c.passed));
  assert.ok(summary.checks.some(c => c.name.includes('settled: API') && !c.passed));
});
