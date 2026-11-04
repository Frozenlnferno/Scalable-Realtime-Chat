const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { parseArgs } = require('node:util');
const YAML = require('yaml');
const { PROFILES, DEFAULT_TIMING } = require('./benchmark.cjs');
const { readAccounts, prepare } = require('./setup.cjs');
const { readTraces, buildSummary, renderSummary } = require('./report.cjs');

function parseOptions(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    profile: { type: 'string', default: 'small' }, tasks: { type: 'string', default: '1' }, seed: { type: 'string', default: '42' },
    accounts: { type: 'string' }, 'env-file': { type: 'string', default: '.env.local' },
    workload: { type: 'string' }, clients: { type: 'string' }, workers: { type: 'string' },
  } });
  if (positionals.length !== 1 || !['chat', 'realtime'].includes(positionals[0])) throw new Error('Usage: npm run bench -- chat|realtime [--profile small|load] [--tasks 1|3] [--seed 42]');
  if (!PROFILES[values.profile] || !/^\d+$/.test(values.tasks) || Number(values.tasks) < 1 || !/^\d+$/.test(values.seed) || Number(values.seed) > 0xffffffff) throw new Error('Invalid profile, task count, or seed.');
  if (values.workload && !['pool', 'sessions'].includes(values.workload)) throw new Error('Workload must be pool or sessions.');
  const pool = positionals[0] === 'realtime' && values.workload !== 'sessions';
  if (pool) {
    if (values.profile === 'load' && !values.clients) throw new Error('Load runs require --clients.');
    const clients = Number(values.clients ?? 4), workers = Number(values.workers ?? 4);
    if (!Number.isSafeInteger(clients) || clients < 2 || clients % 2 || !Number.isSafeInteger(workers) || workers < 1 || workers > 256) throw new Error('Use even --clients >= 2 and --workers in 1..256.');
    return { scenario: 'realtime', workload: 'pool', profile: values.profile, clients, workers, tasks: Number(values.tasks), seed: Number(values.seed), accountsFile: values.accounts || 'users.bench.local.json', envFile: values['env-file'] };
  }
  if (values.clients || values.workers || values.workload === 'pool') throw new Error('Clients/workers/pool apply only to the realtime pool workload.');
  return { scenario: positionals[0], ...(positionals[0] === 'realtime' ? { workload: 'sessions' } : {}), profile: values.profile, tasks: Number(values.tasks), seed: Number(values.seed), accountsFile: values.accounts || 'users.local.json', envFile: values['env-file'] };
}

function validateTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Set CHAT_API_URL to the backend origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('CHAT_API_URL must be an HTTP(S) origin without /api, credentials, or query parameters.');
  return url.origin;
}

async function runBenchmark(options, dependencies = {}) {
  if (options.scenario === 'realtime' && options.workload !== 'sessions') return require('./pool-runner.cjs').runPool(options, dependencies);
  const root = __dirname;
  if (!dependencies.skipVersionCheck) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 18)) throw new Error('Use Node 22.18 or newer for the benchmark runner.');
  }
  const envFile = path.resolve(root, options.envFile || '.env.local');
  // Native parser, no shell sourcing: passwords and tokens are never shell code.
  const localEnv = fs.existsSync(envFile) ? require('node:util').parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
  const env = { ...process.env, ...localEnv };
  const target = validateTarget(env.CHAT_API_URL);
  const cognito = {
    userPoolId: env.CHAT_COGNITO_USER_POOL_ID || env.VITE_COGNITO_USER_POOL_ID,
    userPoolClientId: env.CHAT_COGNITO_CLIENT_ID || env.VITE_COGNITO_USER_POOL_CLIENT_ID,
  };
  if (!dependencies.users && (!cognito.userPoolId || !cognito.userPoolClientId)) throw new Error('Set CHAT_COGNITO_USER_POOL_ID and CHAT_COGNITO_CLIENT_ID in .env.local.');
  const phases = dependencies.phases || PROFILES[options.profile];
  const timing = { ...DEFAULT_TIMING, ...dependencies.timing };
  const expectedSessions = phases.reduce((n, p) => n + (p.arrivalCount ?? p.arrivalRate * p.duration), 0);
  const maxDurationMs = phases.reduce((n, p) => n + p.duration * 1000, 0) + timing.deadlineMs;
  console.log('Preparing accounts and conversations (excluded from measurement)...');
  const users = dependencies.users || await prepare({ accounts: readAccounts(path.resolve(root, options.accountsFile), 4), cognito, target, maxDurationMs });
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const resultsRoot = dependencies.resultsRoot || path.join(root, 'results');
  fs.mkdirSync(resultsRoot, { recursive: true });
  const resultDir = path.join(resultsRoot, `${options.scenario}-${options.tasks}task-${runId}`);
  fs.mkdirSync(resultDir);
  const traceDir = path.join(resultDir, 'traces');
  fs.mkdirSync(traceDir);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bench-'));
  const runtimeFile = path.join(temp, 'runtime.json');
  const casesFile = path.join(temp, 'cases.csv');
  const scriptFile = path.join(temp, 'scenario.yml');
  let child, killTimer;
  let interrupted = false;
  const interrupt = () => { interrupted = true; child?.kill('SIGTERM'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const config = { target, socketTarget: env.CHAT_SOCKET_URL || target, socketPath: env.CHAT_SOCKET_PATH || '/socket.io',
      users, timing, seed: options.seed, runId, traceDir };
    fs.writeFileSync(runtimeFile, JSON.stringify(config), { mode: 0o600 });
    // Enough rows for the busiest worker even when arrivalCount phases run on
    // worker 1. Keeping the same runner/CPU count preserves payload assignment.
    const rows = Math.max(expectedSessions * Math.max(1, os.cpus().length), 1000);
    fs.writeFileSync(casesFile, `caseIndex\n${Array.from({ length: rows }, (_, i) => i).join('\n')}\n`);
    const script = YAML.parse(fs.readFileSync(path.join(root, `${options.scenario}.yml`), 'utf8'));
    script.config.target = target;
    script.config.processor = path.join(root, 'processor.cjs').replaceAll('\\', '/');
    script.config.phases = phases;
    delete script.config.environments;
    script.config.payload.path = casesFile.replaceAll('\\', '/');
    fs.writeFileSync(scriptFile, YAML.stringify(script));
    let gitRevision = 'unknown', gitDirty = null;
    try { gitRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
    try { gitDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch {}
    const sourceHash = createHash('sha256');
    for (const name of fs.readdirSync(root).filter(name => /\.(cjs|yml)$/.test(name) || name === 'package-lock.json').sort()) sourceHash.update(name).update(fs.readFileSync(path.join(root, name)));
    const metadata = { schemaVersion: 2, workloadVersion: 'legacy-sessions-v2', workload: 'sessions', scenario: options.scenario, profile: options.profile, tasks: options.tasks,
      seed: options.seed, accountCount: users.length, expectedSessions, runId, gitRevision, gitDirty, sourceFingerprint: sourceHash.digest('hex'), target,
      phases, timing, nodeVersion: process.version, runnerPlatform: `${os.platform()}/${os.arch()}`,
      runnerCpuCount: os.cpus().length, startedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(resultDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
    const childEnv = { ...env, CHAT_API_URL: target, BENCH_RUNTIME_FILE: runtimeFile, BENCH_CASES_FILE: casesFile,
      ARTILLERY_DISABLE_TELEMETRY: 'true', ARTILLERY_DISABLE_UPDATE_CHECK: 'true' };
    delete childEnv.DEBUG; delete childEnv.CHAT_ID_TOKEN; delete childEnv.CHAT_RECIPIENT_ID_TOKEN;
    const cli = path.join(path.dirname(require.resolve('artillery/package.json')), 'bin', 'run');
    const reportPath = path.join(resultDir, 'artillery.json');
    const exitCode = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [cli, 'run', scriptFile, '--output', reportPath], {
        cwd: root, env: childEnv, stdio: dependencies.quiet ? ['ignore', 'ignore', 'ignore'] : 'inherit', windowsHide: true,
      });
      child.once('error', () => reject(new Error('Could not start Artillery.')));
      child.once('exit', code => resolve(code ?? 1));
      killTimer = setTimeout(() => { interrupted = true; child.kill('SIGTERM'); }, maxDurationMs + 60000);
    });
    clearTimeout(killTimer);
    const raw = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : {};
    const summary = buildSummary({ ...metadata, endedAt: new Date().toISOString(), interrupted }, raw, readTraces(traceDir), interrupted ? 1 : exitCode);
    fs.writeFileSync(path.join(resultDir, 'summary.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(resultDir, 'summary.md'), renderSummary(summary));
    console.log(`\n${summary.passed ? 'PASS' : 'FAIL'}: ${path.join(resultDir, 'summary.md')}`);
    return { resultDir, summary, exitCode: summary.passed ? 0 : 1 };
  } finally {
    clearTimeout(killTimer);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    // These exact files were created above in an OS temporary directory. No
    // recursive deletion or computed directory traversal is used for cleanup.
    for (const file of [runtimeFile, casesFile, scriptFile]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(temp);
  }
}

if (require.main === module) {
  let options;
  try { options = parseOptions(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  if (options) runBenchmark(options).then(r => { process.exitCode = r.exitCode; }).catch(error => {
    // Only setup/configuration errors are surfaced; remote responses and raw
    // authentication exceptions never reach this handler.
    console.error(`Benchmark stopped: ${error.message}`); process.exitCode = 1;
  });
}
module.exports = { parseOptions, validateTarget, runBenchmark };
