const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { parseEnv } = require('node:util');
const YAML = require('yaml');
const { VERSION, THRESHOLDS, TIMING, hash, selectAccounts, schedule, partition } = require('./pool.cjs');
const { readAccounts, prepare } = require('./setup.cjs');
const { summarizePool, renderPool } = require('./pool-report.cjs');

function validateTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Set CHAT_API_URL to the backend origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('CHAT_API_URL must be an HTTP(S) origin without /api, credentials, or query parameters.');
  }
  return url.origin;
}

async function runPool(options, dependencies = {}) {
  const root = __dirname;
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 22) || typeof process.threadCpuUsage !== 'function') throw new Error('Use Node 22.22 or newer for per-worker CPU measurements.');
  if (options.profile === 'load' && options.clients == null) throw new Error('Load runs require --clients.');
  const envFile = path.resolve(root, options.envFile || '.env.local');
  const env = { ...process.env, ...(fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {}) };
  const target = validateTarget(env.CHAT_API_URL);
  const cognito = { userPoolId: env.CHAT_COGNITO_USER_POOL_ID || env.VITE_COGNITO_USER_POOL_ID,
    userPoolClientId: env.CHAT_COGNITO_CLIENT_ID || env.VITE_COGNITO_USER_POOL_CLIENT_ID };
  const timing = { ...TIMING, ...(options.profile === 'small' ? { rampMs: 2000, measureMs: 10000 } : {}), ...dependencies.timing };
  const clients = options.clients ?? 4;
  const workersRequested = options.workers ?? 4;
  if (!Number.isInteger(workersRequested) || workersRequested < 1 || workersRequested > 256) throw new Error('Workers must be 1..256.');
  const accounts = dependencies.users ? dependencies.users.map((u, i) => ({ username: `fixture-${i}` })) : readAccounts(path.resolve(root, options.accountsFile || 'users.bench.local.json'));
  const selected = selectAccounts(accounts, clients, options.seed);
  const workers = partition(selected, workersRequested).length;
  timing.connectConcurrency = Math.max(timing.connectConcurrency, workers);
  if (!dependencies.users && (!cognito.userPoolId || !cognito.userPoolClientId)) throw new Error('Configure Cognito pool and app client.');
  console.log(`Preparing ${clients} distinct identities and ${clients / 2} conversations (excluded from measurement)...`);
  let users;
  const maxDurationMs = timing.rampMs + timing.graceMs + timing.measureMs + timing.drainMs + 60000;
  if (dependencies.users) {
    users = selected.map(a => ({ ...dependencies.users[Number(a.username.split('-')[1])] }));
    for (let i = 0; i < users.length; i += 2) {
      const response = await fetch(`${target}/api/conversations/direct`, { method: 'POST', headers: { Authorization: `Bearer ${users[i].token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ recipientUserId: users[i + 1].id }) });
      const data = await response.json();
      users[i].conversationId = users[i + 1].conversationId = data.conversation.id;
    }
  } else users = await prepare({ accounts: selected, cognito, target, maxDurationMs, pool: true });
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const resultDir = path.join(dependencies.resultsRoot || path.join(root, 'results'), `realtime-pool-${options.tasks}task-${runId}`);
  fs.mkdirSync(path.join(resultDir, 'traces'), { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-pool-'));
  const runtimeFile = path.join(temp, 'runtime.json'), scriptFile = path.join(temp, 'scenario.yml');
  let child, timer, interrupted = false;
  const interrupt = () => { interrupted = true; child?.kill('SIGTERM'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const config = { users, seed: options.seed, runId, timing, workers, traceDir: path.join(resultDir, 'traces'), target,
      socketTarget: env.CHAT_SOCKET_URL || target, socketPath: env.CHAT_SOCKET_PATH || '/socket.io' };
    fs.writeFileSync(runtimeFile, JSON.stringify(config), { mode: 0o600 });
    const script = YAML.parse(fs.readFileSync(path.join(root, 'pool.yml'), 'utf8'));
    script.config.target = target; script.config.processor = path.join(root, 'pool-controller.cjs').replaceAll('\\', '/');
    fs.writeFileSync(scriptFile, YAML.stringify(script));
    let gitRevision = 'unknown', gitDirty = null;
    try {
      gitRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      gitDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    } catch {}
    const source = createHash('sha256');
    for (const name of fs.readdirSync(root).filter(n => /\.(cjs|yml)$/.test(n) || n === 'package-lock.json').sort()) source.update(name).update(fs.readFileSync(path.join(root, name)));
    const scheduleHash = createHash('sha256');
    for (let i = 0; i < clients; i++) scheduleHash.update(JSON.stringify([i, schedule(options.seed, i, timing)]));
    const metadata = { schemaVersion: 3, workloadVersion: VERSION, scenario: 'realtime', workload: 'pool', profile: options.profile,
      clients, accountCount: clients, pairCount: clients / 2, poolSize: accounts.length, workers, workersRequested,
      seed: options.seed, tasks: options.tasks, runId, timing, thresholds: THRESHOLDS, target,
      socketTarget: config.socketTarget, socketPath: config.socketPath, gitRevision, gitDirty, sourceFingerprint: source.digest('hex'),
      accountFingerprint: hash(selected.map(a => a.username)), pairFingerprint: hash(users.map(u => [u.id, u.conversationId])), scheduleFingerprint: scheduleHash.digest('hex'),
      poolFingerprint: hash(accounts.map(a => a.username).sort()),
      nodeVersion: process.version, runnerPlatform: `${os.platform()}/${os.arch()}`, runnerCpuCount: os.cpus().length,
      startedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(resultDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
    const childEnv = { ...env, BENCH_RUNTIME_FILE: runtimeFile, ARTILLERY_DISABLE_TELEMETRY: 'true', ARTILLERY_DISABLE_UPDATE_CHECK: 'true' };
    delete childEnv.DEBUG; delete childEnv.CHAT_ID_TOKEN; delete childEnv.CHAT_RECIPIENT_ID_TOKEN;
    const reportPath = path.join(resultDir, 'artillery.json');
    const cli = path.join(path.dirname(require.resolve('artillery/package.json')), 'bin', 'run');
    const exitCode = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [cli, 'run', scriptFile, '--output', reportPath], { cwd: root, env: childEnv,
        stdio: dependencies.quiet ? 'ignore' : 'inherit', windowsHide: true });
      child.once('error', () => reject(new Error('Could not start Artillery.')));
      child.once('exit', code => resolve(code ?? 1));
      timer = setTimeout(interrupt, maxDurationMs + 30000);
    });
    clearTimeout(timer);
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch {}
    if (!fs.existsSync(reportPath)) fs.writeFileSync(reportPath, JSON.stringify({ aggregate: {}, error: 'Artillery did not produce a report.' }, null, 2));
    const summary = await summarizePool({ ...metadata, endedAt: new Date().toISOString(), interrupted }, raw, config.traceDir, interrupted ? 1 : exitCode);
    fs.writeFileSync(path.join(resultDir, 'summary.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(resultDir, 'summary.md'), renderPool(summary));
    console.log(`${summary.passed ? 'PASS' : 'FAIL'}: ${path.join(resultDir, 'summary.md')}`);
    return { resultDir, summary, exitCode: summary.passed ? 0 : 1 };
  } finally {
    clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    for (const file of [runtimeFile, scriptFile]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(temp);
  }
}
module.exports = { runPool };
