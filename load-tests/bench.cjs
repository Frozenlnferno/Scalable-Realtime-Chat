const { parseArgs } = require('node:util');
const { runPool } = require('./pool-runner.cjs');

function parseOptions(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    profile: { type: 'string', default: 'small' }, tasks: { type: 'string', default: '1' }, seed: { type: 'string', default: '42' },
    accounts: { type: 'string', default: 'users.bench.local.json' }, 'env-file': { type: 'string', default: '.env.local' },
    clients: { type: 'string' }, workers: { type: 'string', default: '4' },
  } });
  if (positionals.length !== 1 || positionals[0] !== 'realtime') throw new Error('Usage: npm run bench -- realtime [--profile small|load] [--clients N] [--workers N] [--tasks N] [--seed N]');
  if (!['small', 'load'].includes(values.profile) || !/^\d+$/.test(values.tasks) || Number(values.tasks) < 1 || !/^\d+$/.test(values.seed) || Number(values.seed) > 0xffffffff) throw new Error('Invalid profile, task count, or seed.');
  if (values.profile === 'load' && !values.clients) throw new Error('Load runs require --clients.');
  const clients = Number(values.clients ?? 4), workers = Number(values.workers);
  if (!Number.isSafeInteger(clients) || clients < 2 || clients % 2 || !Number.isSafeInteger(workers) || workers < 1 || workers > 256) throw new Error('Use even --clients >= 2 and --workers in 1..256.');
  return { scenario: 'realtime', workload: 'pool', profile: values.profile, clients, workers,
    tasks: Number(values.tasks), seed: Number(values.seed), accountsFile: values.accounts, envFile: values['env-file'] };
}

async function runBenchmark(options, dependencies = {}) {
  if (options.scenario !== 'realtime' || (options.workload && options.workload !== 'pool')) throw new Error('Only the realtime pool workload is supported.');
  return runPool(options, dependencies);
}

if (require.main === module) {
  let options;
  try { options = parseOptions(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  if (options) runBenchmark(options).then(result => { process.exitCode = result.exitCode; }).catch(error => {
    console.error(`Benchmark stopped: ${error.message}`); process.exitCode = 1;
  });
}
module.exports = { parseOptions, runBenchmark };
