const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, p50: null, p95: null, p99: null, max: null };
  const percentile = p => +sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)].toFixed(2);
  return { count: sorted.length, mean: +(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2),
    p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: +sorted.at(-1).toFixed(2) };
}

function readTraces(directory) {
  return fs.readdirSync(directory).filter(f => f.endsWith('.jsonl')).flatMap(file => {
    return fs.readFileSync(path.join(directory, file), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  }).sort((a, b) => a.at - b.at);
}

function concurrency(records) {
  const sessions = new Set(), sockets = new Set();
  let peakSessions = 0, peakSockets = 0, valid = true;
  const timeline = [];
  for (const record of [...records].sort((a, b) => a.at - b.at)) {
    const set = record.type.startsWith('session_') ? sessions : sockets;
    const id = record.type.startsWith('session_') ? record.session : record.socket;
    if (!['session_open', 'session_close', 'socket_open', 'socket_close'].includes(record.type)) continue;
    if (record.type.endsWith('_open')) {
      if (set.has(id)) valid = false;
      set.add(id);
    } else if (!set.delete(id)) valid = false;
    peakSessions = Math.max(peakSessions, sessions.size);
    peakSockets = Math.max(peakSockets, sockets.size);
    timeline.push({ at: record.at, sessions: sessions.size, sockets: sockets.size });
  }
  return { peakSessions, peakSockets, valid: valid && !sessions.size && !sockets.size, timeline };
}

function summarizeWindow(records, start, end, timeline) {
  const rows = records.filter(r => r.at >= start && r.at < end);
  const durationSeconds = Math.max(0, end - start) / 1000;
  const requests = rows.filter(r => r.type === 'request_end');
  const successes = requests.filter(r => r.success);
  const count = type => rows.filter(r => r.type === type).length;
  const timings = metric => distribution(rows.filter(r => r.type === 'timing' && r.metric === metric).map(r => r.durationMs));
  const rate = n => durationSeconds ? +(n / durationSeconds).toFixed(3) : 0;
  const carry = timeline.filter(r => r.at < start).at(-1) || { sessions: 0, sockets: 0 };
  const active = [carry, ...timeline.filter(r => r.at >= start && r.at < end)];
  const failures = {};
  const counted = new Set();
  for (const r of rows.filter(r => r.type === 'failure' || (r.type === 'session_close' && !r.success))) {
    const key = `${r.session}/${r.reason}`;
    if (counted.has(key)) continue;
    counted.add(key);
    failures[r.reason] = (failures[r.reason] || 0) + 1;
  }
  // Session outcomes and failure-event counters are reported independently below;
  // do not sum this diagnostic map into a session failure percentage.
  return {
    start: new Date(start).toISOString(), end: new Date(end).toISOString(), durationSeconds,
    sessionsStarted: count('session_open'), sessionsCompleted: rows.filter(r => r.type === 'session_close' && r.success).length,
    sessionsFailed: rows.filter(r => r.type === 'session_close' && !r.success).length,
    requestAttempts: count('request_start'), requestSuccesses: successes.length, requestFailures: requests.length - successes.length,
    httpStatuses: requests.reduce((result, r) => { const status = r.status || 'transport'; result[status] = (result[status] || 0) + 1; return result; }, {}),
    successfulRequestsPerSecond: rate(successes.length),
    messagesAttempted: count('message_attempted'), messagesSent: count('message_sent'),
    recipientConfirmations: timings('delivery_ms').count, senderConfirmations: timings('echo_ms').count,
    successfulMessageWritesPerSecond: rate(count('message_sent')),
    recipientConfirmationsPerSecond: rate(timings('delivery_ms').count),
    apiMs: distribution(requests.map(r => r.durationMs)),
    endpoints: Object.fromEntries(['users', 'open_conversation', 'history', 'send_message'].map(name => [name,
      distribution(requests.filter(r => r.endpoint === name).map(r => r.durationMs))])),
    deliveryMs: timings('delivery_ms'), echoMs: timings('echo_ms'), connectMs: timings('connect_ms'),
    peakSessions: Math.max(...active.map(r => r.sessions)), peakSockets: Math.max(...active.map(r => r.sockets)),
    unexpectedDisconnects: rows.filter(r => r.type === 'failure' && r.reason === 'socket_disconnected').length,
    duplicates: rows.filter(r => r.type === 'failure' && r.reason === 'duplicate_delivery').length,
    deliveryTimeouts: rows.filter(r => r.type === 'failure' && r.reason === 'delivery_timeout').length,
    echoTimeouts: rows.filter(r => r.type === 'failure' && r.reason === 'echo_timeout').length,
    failureReasons: failures,
  };
}

function buildSummary(metadata, raw, records, cliExitCode) {
  const life = concurrency(records);
  const phase = records.filter(r => r.type === 'phase' && r.index === 0).sort((a, b) => a.at - b.at)[0];
  const start = phase?.at ?? records[0]?.at ?? Date.now();
  const end = Math.max(start + 1, ...records.map(r => r.at)) + 1;
  const whole = summarizeWindow(records, start, end, life.timeline);
  const windows = { whole };
  if (metadata.profile === 'load') {
    const steady = records.find(r => r.type === 'phase' && r.index === 2);
    const steadyStart = steady?.at ?? start + 180000;
    const steadyEnd = steadyStart + (metadata.phases?.[2]?.duration ?? 300) * 1000;
    windows.steady = summarizeWindow(records, steadyStart, steadyEnd, life.timeline);
    windows.settled = summarizeWindow(records, Math.min(steadyStart + (metadata.timing?.holdMs ?? 60000), steadyEnd), steadyEnd, life.timeline);
  }
  const counters = raw?.aggregate?.counters || {};
  const check = (name, passed) => ({ name, passed: Boolean(passed) });
  const checks = [
    check('Artillery exited successfully', cliExitCode === 0),
    check('Phase boundaries recorded', phase && (metadata.profile !== 'load' || records.some(r => r.type === 'phase' && r.index === 2))),
    check('Every scheduled session started', whole.sessionsStarted === metadata.expectedSessions && counters['vusers.created'] === metadata.expectedSessions),
    check('Every scheduled session completed', whole.sessionsCompleted === metadata.expectedSessions && !whole.sessionsFailed && counters['vusers.completed'] === metadata.expectedSessions && !counters['vusers.failed']),
    check('Every planned request succeeded', whole.requestSuccesses === metadata.expectedSessions * 8 && !whole.requestFailures && whole.requestAttempts === whole.requestSuccesses),
    check('Every planned message posted', whole.messagesAttempted === metadata.expectedSessions * 5 && whole.messagesSent === metadata.expectedSessions * 5),
    check('Lifecycle traces closed cleanly', life.valid),
    check('API p95 below 500 ms', whole.apiMs.p95 !== null && whole.apiMs.p95 < 500),
  ];
  if (metadata.scenario === 'realtime') checks.push(
    check('Every recipient confirmed delivery', whole.recipientConfirmations === metadata.expectedSessions * 5),
    check('Every sender confirmed echo', whole.senderConfirmations === metadata.expectedSessions * 5),
    check('Delivery p95 below 200 ms', whole.deliveryMs.p95 !== null && whole.deliveryMs.p95 < 200),
    check('No unexpected disconnects or duplicates', whole.unexpectedDisconnects === 0 && whole.duplicates === 0),
  );
  const assignments = records.filter(r => r.type === 'session_open').map(r => [r.caseIndex, r.sender, r.recipient]).sort((a, b) => a[0] - b[0]);
  return { metadata, passed: checks.every(c => c.passed), checks,
    workloadFingerprint: createHash('sha256').update(JSON.stringify(assignments)).digest('hex'),
    observedWorkers: [...new Set(records.filter(r => r.type === 'session_open').map(r => r.worker))].length,
    messagesPlanned: metadata.expectedSessions * 5,
    timingDefinition: metadata.scenario === 'chat' ? 'HTTP time to first byte' : 'HTTP through JSON parsing; delivery from POST start to designated socket receipt',
    windows, concurrency: life,
    limitations: ['Accounts are reused; connections are not distinct users.', 'No backend instance routing or cross-instance delivery proof.',
      'Window rates count completions inside each wall-clock window, not sessions grouped by start time.',
      'Lifecycle timestamps have millisecond resolution; ordering across workers at the same millisecond is approximate.',
      'Successful delivery timing samples exclude missing deliveries; inspect failures and confirmation counts.'] };
}

function renderSummary(summary) {
  const lines = [`# ${summary.metadata.scenario} benchmark: ${summary.passed ? 'PASS' : 'FAIL'}`,
    '', `Profile: ${summary.metadata.profile}; declared ECS tasks: ${summary.metadata.tasks}; accounts: ${summary.metadata.accountCount}; seed: ${summary.metadata.seed}.`,
    '', `Run: ${summary.metadata.runId}. Git: ${summary.metadata.gitRevision}.`,
    '', `Timing: ${summary.timingDefinition}.`, '', '| Window | Seconds | Successful req/s | Writes/s | API p95 ms | Delivery p95 / p99 ms | Peak sockets |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const [name, w] of Object.entries(summary.windows)) lines.push(`| ${name} | ${w.durationSeconds.toFixed(1)} | ${w.successfulRequestsPerSecond} | ${w.successfulMessageWritesPerSecond} | ${w.apiMs.p95 ?? '-'} | ${w.deliveryMs.p95 ?? '-'} / ${w.deliveryMs.p99 ?? '-'} | ${w.peakSockets} |`);
  const w = summary.windows.whole;
  lines.push('', `Sessions: ${w.sessionsCompleted}/${summary.metadata.expectedSessions} completed; ${w.sessionsFailed} failed.`,
    `Messages: ${w.messagesSent}/${summary.messagesPlanned} posted; ${w.recipientConfirmations} recipient confirmations; ${w.senderConfirmations} sender echoes.`,
    `Peak concurrent sessions: ${w.peakSessions}; sockets: ${w.peakSockets}; distinct account pool: ${summary.metadata.accountCount}.`,
    `HTTP statuses: ${JSON.stringify(w.httpStatuses)}; request failures: ${w.requestFailures}.`,
    `Disconnects: ${w.unexpectedDisconnects}; duplicates: ${w.duplicates}; delivery/echo timeouts: ${w.deliveryTimeouts}/${w.echoTimeouts}.`,
    `Failure reasons: ${JSON.stringify(w.failureReasons)}.`,
    '', '## Whole-run timings (ms)', '', '| Measurement | Samples | p50 | p95 | p99 | Max |', '| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const [name, d] of Object.entries({ ...w.endpoints, recipient_delivery: w.deliveryMs, sender_echo: w.echoMs, socket_connection: w.connectMs })) {
    lines.push(`| ${name} | ${d.count} | ${d.p50 ?? '-'} | ${d.p95 ?? '-'} | ${d.p99 ?? '-'} | ${d.max ?? '-'} |`);
  }
  lines.push(
    '', '## Checks', '', ...summary.checks.map(c => `- ${c.passed ? 'PASS' : 'FAIL'}: ${c.name}`),
    '', '## Interpretation limits', '', ...summary.limitations.map(s => `- ${s}`));
  return `${lines.join('\n')}\n`;
}

module.exports = { distribution, readTraces, concurrency, summarizeWindow, buildSummary, renderSummary };
