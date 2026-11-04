const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { hash, VERSION } = require('./pool.cjs');
function comparisonKey(s, mode) {
  const m = s.metadata;
  if (m?.workloadVersion !== VERSION || m.schemaVersion !== 3) throw new Error('Legacy and revised workloads are incompatible.');
  const keys = ['workloadVersion', 'profile', 'seed', 'timing', 'thresholds', 'workers', 'workersRequested', 'nodeVersion',
    'runnerPlatform', 'runnerCpuCount', 'target', 'socketTarget', 'socketPath', 'sourceFingerprint', 'gitRevision', 'poolFingerprint'];
  if (mode === 'fixed') keys.push('clients', 'accountFingerprint', 'pairFingerprint', 'scheduleFingerprint');
  for (const key of keys) if (m[key] == null) throw new Error(`Missing comparison metadata: ${key}`);
  return hash(keys.map(k => [k, m[k]]));
}
function compare(summaries, mode) {
  if (!['fixed', 'capacity'].includes(mode) || summaries.length < 2) throw new Error('Use --mode fixed|capacity and at least two run directories.');
  const key = comparisonKey(summaries[0], mode);
  if (summaries.some(s => comparisonKey(s, mode) !== key)) throw new Error('Incompatible workload, selection, thresholds, source or runner configuration.');
  if (new Set(summaries.map(s => s.metadata.runId)).size !== summaries.length) throw new Error('Repeated paths/run IDs cannot count as repetitions.');
  const groups = new Map();
  for (const s of summaries) {
    const id = `${s.metadata.tasks}/${s.metadata.clients}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(s);
  }
  const levels = [...groups.values()].map(runs => {
    const passing = runs.filter(r => r.passed && r.capacityEligible);
    // Failed repetitions at a level prevent a consistent sustainability claim.
    return { tasks: runs[0].metadata.tasks, clients: runs[0].metadata.clients, repetitions: runs.length, passing: passing.length,
      consistentlySustainable: passing.length >= 3 && passing.length === runs.length,
      measuredConfirmedPerSecond: passing.length ? passing.reduce((n, r) => n + r.windows.whole.rates.confirmed, 0) / passing.length : 0,
      failures: runs.filter(r => !r.passed || !r.capacityEligible).map(r => r.metadata.runId) };
  }).sort((a, b) => a.tasks - b.tasks || a.clients - b.clients);
  const capacities = [...new Set(levels.map(l => l.tasks))].map(tasks => {
    const tested = levels.filter(l => l.tasks === tasks);
    const best = tested.filter(l => l.consistentlySustainable).sort((a, b) => b.measuredConfirmedPerSecond - a.measuredConfirmedPerSecond)[0] || null;
    return { tasks, highestTestedSustainable: best, higherFailingLevels: tested.filter(l => l.failures.length && (!best || l.clients > best.clients)) };
  });
  const ratios = [];
  if (mode === 'capacity') {
    for (let i = 1; i < capacities.length; i++) {
      const a = capacities[0], b = capacities[i];
      if (a.highestTestedSustainable && b.highestTestedSustainable) ratios.push({ fromTasks: a.tasks, toTasks: b.tasks,
        confirmedThroughputRatio: b.highestTestedSustainable.measuredConfirmedPerSecond / a.highestTestedSustainable.measuredConfirmedPerSecond });
    }
  } else {
    for (let i = 1; i < levels.length; i++) if (levels[0].consistentlySustainable && levels[i].consistentlySustainable)
      ratios.push({ fromTasks: levels[0].tasks, toTasks: levels[i].tasks,
        confirmedThroughputRatio: levels[i].measuredConfirmedPerSecond / levels[0].measuredConfirmedPerSecond });
  }
  return { mode, levels, capacities, ratios, limitations: ['Three passing repetitions per candidate level are required.',
    'Highest tested sustainable throughput is not an absolute backend maximum, including at the pool ceiling.', 'Task routing and Redis forwarding evidence are separate.'] };
}
if (require.main === module) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { mode: { type: 'string', default: 'fixed' } } });
    const result = compare(positionals.map(dir => JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'))), values.mode);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { compare, comparisonKey };
