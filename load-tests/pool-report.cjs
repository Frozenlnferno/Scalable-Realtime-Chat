const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { schedule } = require('./pool.cjs');

// Bounded streaming histograms. Millisecond ceiling is conservative at limits.
class Histogram {
  bins = new Map(); count = 0; sum = 0; max = 0;
  add(value) {
    if (!Number.isFinite(value) || value < 0) return;
    const bucket = Math.min(3600000, Math.ceil(value));
    this.bins.set(bucket, (this.bins.get(bucket) || 0) + 1);
    this.count++; this.sum += value; this.max = Math.max(this.max, value);
  }
  summary() {
    const sorted = [...this.bins].sort((a, b) => a[0] - b[0]);
    const percentile = p => {
      let n = 0;
      for (const [v, count] of sorted) { n += count; if (n >= Math.ceil(this.count * p)) return v; }
      return null;
    };
    return { count: this.count, mean: this.count ? this.sum / this.count : null, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: this.count ? this.max : null };
  }
}
async function* traces(directory) {
  for (const file of fs.readdirSync(directory).filter(f => f.endsWith('.jsonl')).sort()) {
    const lines = readline.createInterface({ input: fs.createReadStream(path.join(directory, file)), crlfDelay: Infinity });
    for await (const line of lines) if (line.trim()) yield JSON.parse(line);
  }
}
async function summarizePool(metadata, raw, directory, exitCode) {
  const life = [], health = {}, workerLags = {}, boundaries = [];
  let setupFailures = 0, disconnects = 0, duplicates = 0, missed = 0, limits = 0;
  // Pass 1 establishes the shared measurement epoch without loading traces.
  for await (const row of traces(directory)) if (row.type === 'measurement_start') boundaries.push(row);
  const start = boundaries[0]?.start ?? 0, end = start + metadata.timing.measureMs;
  const starts = { whole: start, settled: Math.max(start, end - 240000) };
  const windows = {};
  for (const [name, from] of Object.entries(starts)) {
    let planned = 0;
    for (let i = 0; i < metadata.clients; i++) planned += schedule(metadata.seed, i, metadata.timing).filter(ms => ms >= from - start).length;
    windows[name] = { start: from, end, durationSeconds: (end - from) / 1000, planned, attempted: 0, posted: 0,
      confirmed: 0, echoed: 0, ambiguous: 0, recipientObserved: 0, echoObserved: 0,
      receiptTimeConfirmations: 0, apiMs: new Histogram(), recipientMs: new Histogram(), echoMs: new Histogram() };
  }
  for await (const row of traces(directory)) {
    if (row.type === 'setup_failure') setupFailures++;
    if (row.type === 'disconnect') disconnects++;
    if (row.type === 'duplicate') duplicates++;
    if (row.type === 'health') health[row.worker] = row;
    if (['socket_open', 'socket_close'].includes(row.type)) life.push(row);
    if (row.type !== 'message') continue;
    missed += Number(Boolean(row.missed)); limits += Number(Boolean(row.limit));
    (workerLags[row.worker] ||= new Histogram()).add(row.lag);
    for (const [name, from] of Object.entries(starts)) {
      const w = windows[name];
      if (row.recipient && row.recipient.at >= from && row.recipient.at < end) w.receiptTimeConfirmations++;
      if (row.scheduledAt < from || row.scheduledAt >= end) continue;
      for (const field of ['attempted', 'posted', 'ambiguous', 'recipientObserved', 'echoObserved']) w[field] += Number(Boolean(row[field]));
      w.confirmed += Number(Boolean(row.recipient)); w.echoed += Number(Boolean(row.echo));
      w.apiMs.add(row.apiMs); w.recipientMs.add(row.recipient?.ms); w.echoMs.add(row.echo?.ms);
    }
  }
  for (const w of Object.values(windows)) {
    w.unattempted = w.planned - w.attempted;
    w.missingRecipientEvents = w.attempted - w.recipientObserved; w.missingEchoEvents = w.attempted - w.echoObserved;
    w.unconfirmedPostedPercentage = w.posted ? 100 * (w.posted - w.confirmed) / w.posted : null;
    w.scheduledCompletionPercentage = w.planned ? 100 * w.confirmed / w.planned : 0;
    w.rates = Object.fromEntries(['planned', 'attempted', 'posted', 'confirmed'].map(key => [key, w[key] / w.durationSeconds]));
    w.receiptTimeConfirmationsPerSecond = w.receiptTimeConfirmations / w.durationSeconds;
    for (const key of ['apiMs', 'recipientMs', 'echoMs']) w[key] = w[key].summary();
  }
  life.sort((a, b) => a.at - b.at || (a.type === 'socket_open' ? -1 : 1));
  const active = new Set(), identities = new Set(), timeline = [];
  let peak = 0, minimum = metadata.clients, valid = true;
  for (const row of life) {
    if (row.at >= start && row.at < end) minimum = Math.min(minimum, active.size);
    if (row.type === 'socket_open') {
      if (active.has(row.index)) valid = false;
      active.add(row.index); identities.add(row.index);
    } else if (!active.delete(row.index)) valid = false;
    peak = Math.max(peak, active.size);
    if (row.at >= start && row.at < end) minimum = Math.min(minimum, active.size);
    timeline.push({ at: row.at, activeSockets: active.size, distinctIdentities: active.size });
  }
  const atStart = timeline.filter(r => r.at <= start).at(-1)?.activeSockets || 0;
  minimum = Math.min(minimum, atStart);
  valid &&= active.size === 0;
  const lag = Object.fromEntries(Object.entries(workerLags).map(([id, h]) => [id, h.summary()]));
  const generatorEligible = missed === 0 && limits === 0 && Object.keys(health).length === metadata.workers && Object.keys(lag).length === metadata.workers &&
    Object.values(lag).every(h => h.p95 !== null && h.p95 <= metadata.thresholds.dispatchP95Ms);
  const checks = [];
  const check = (name, passed) => checks.push({ name, passed: Boolean(passed) });
  check('Artillery controller completed', exitCode === 0 && raw.aggregate?.counters?.['vusers.completed'] === 1 && !raw.aggregate?.counters?.['vusers.failed']);
  check('All workers entered the same measurement window', !setupFailures && boundaries.length === metadata.workers && boundaries.every(b => b.start === start));
  check('All identities remained connected throughout measurement', valid && minimum === metadata.clients && identities.size === metadata.clients && !disconnects);
  check('No duplicate matching events', duplicates === 0);
  check('Generator eligible for capacity claims', generatorEligible);
  for (const [name, w] of Object.entries(windows)) {
    check(`${name}: every scheduled message attempted, posted and confirmed on both sockets`, w.planned > 0 && [w.attempted, w.posted, w.confirmed, w.echoed].every(n => n === w.planned));
    check(`${name}: API p95 below ${metadata.thresholds.apiP95Ms} ms`, w.apiMs.p95 !== null && w.apiMs.p95 < metadata.thresholds.apiP95Ms);
    check(`${name}: recipient p95 below ${metadata.thresholds.recipientP95Ms} ms`, w.recipientMs.p95 !== null && w.recipientMs.p95 < metadata.thresholds.recipientP95Ms);
  }
  return { metadata, passed: checks.every(c => c.passed), capacityEligible: generatorEligible && checks.every(c => c.passed), checks, windows,
    concurrency: { minimum, peak, distinctConnectedIdentities: identities.size, valid, timeline },
    generator: { missedSlots: missed, inFlightLimitHits: limits, dispatchLagMs: lag, workers: health },
    disconnects, duplicates, setupFailures,
    timingDefinition: 'POST through JSON parsing; designated socket handler latency from POST initiation. Cohorts use scheduled time including final drain; receipt-time throughput excludes drain. Percentiles rounded up to 1 ms.',
    limitations: ['ECS tasks are declared metadata and must be held fixed manually.', 'No per-task routing or Redis cross-instance proof.', 'Highest tested sustainable throughput is not an absolute backend maximum.', 'Runs leave persistent database messages.'] };
}
function renderPool(s) {
  const lines = [`# Distinct-user benchmark: ${s.passed ? 'PASS' : 'FAIL'}`, '',
    `${s.metadata.clients} clients / sockets; ${s.metadata.clients / 2} pairs; ${s.metadata.workers} workers; seed ${s.metadata.seed}; declared ECS tasks ${s.metadata.tasks}.`,
    `Workload: ${s.metadata.workloadVersion}. Run: ${s.metadata.runId}. Source: ${s.metadata.gitRevision}.`, '',
    `Started: ${s.metadata.startedAt}; ended: ${s.metadata.endedAt}.`,
    `Timing (ms): ${JSON.stringify(s.metadata.timing)}. Thresholds (ms): ${JSON.stringify(s.metadata.thresholds)}.`,
    `Fingerprints: accounts ${s.metadata.accountFingerprint}; pairs ${s.metadata.pairFingerprint}; schedule ${s.metadata.scheduleFingerprint}.`, '',
    '| Window | Seconds | Scheduled/s | Attempted/s | Writes/s | Confirmed/s | Receipt-time/s | API p95 ms | Recipient p95 ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const [name, w] of Object.entries(s.windows)) {
    lines.push(`| ${name} | ${w.durationSeconds} | ${w.rates.planned.toFixed(3)} | ${w.rates.attempted.toFixed(3)} | ${w.rates.posted.toFixed(3)} | ${w.rates.confirmed.toFixed(3)} | ${w.receiptTimeConfirmationsPerSecond.toFixed(3)} | ${w.apiMs.p95 ?? '-'} | ${w.recipientMs.p95 ?? '-'} |`);
  }
  for (const [name, w] of Object.entries(s.windows)) {
    lines.push('', `${name}: ${w.planned} planned, ${w.attempted} attempted, ${w.posted} posted, ${w.confirmed} recipient confirmations, ${w.echoed} echoes, ${w.ambiguous} ambiguous, ${w.unattempted} unattempted. Unconfirmed posted: ${w.unconfirmedPostedPercentage ?? '-'}%; scheduled completion: ${w.scheduledCompletionPercentage.toFixed(2)}%.`, '');
    lines.push(`Missing recipient events: ${w.missingRecipientEvents}; missing echoes: ${w.missingEchoEvents}. API p50/p95/p99: ${w.apiMs.p50}/${w.apiMs.p95}/${w.apiMs.p99} ms; recipient: ${w.recipientMs.p50}/${w.recipientMs.p95}/${w.recipientMs.p99} ms.`, '');
  }
  lines.push(`Sockets: min ${s.concurrency.minimum}, peak ${s.concurrency.peak}; distinct identities ${s.concurrency.distinctConnectedIdentities}. Disconnects: ${s.disconnects}; duplicates: ${s.duplicates}.`,
    `Generator: ${s.generator.missedSlots} missed slots; ${s.generator.inFlightLimitHits} in-flight limit hits. Capacity eligible: ${s.capacityEligible}.`,
    '', '| Worker | CPU user/system ms | Event-loop p95/max ms | Dispatch p95 ms |', '| --- | ---: | ---: | ---: |');
  for (const [id, health] of Object.entries(s.generator.workers)) lines.push(`| ${id} | ${(health.cpuMicros?.user || 0) / 1000} / ${(health.cpuMicros?.system || 0) / 1000} | ${health.eventLoopMs?.p95 ?? '-'} / ${health.eventLoopMs?.max ?? '-'} | ${s.generator.dispatchLagMs[id]?.p95 ?? '-'} |`);
  lines.push('', s.timingDefinition, '', ...s.checks.map(c => `- ${c.passed ? 'PASS' : 'FAIL'}: ${c.name}`), '', ...s.limitations.map(l => `- ${l}`));
  return lines.join('\n') + '\n';
}
module.exports = { Histogram, traces, summarizePool, renderPool };
