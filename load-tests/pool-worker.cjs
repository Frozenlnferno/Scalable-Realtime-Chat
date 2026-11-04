const fs = require('node:fs');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { parentPort, workerData, isMainThread } = require('node:worker_threads');
const { io } = require('socket.io-client');
const { schedule, mapLimit } = require('./pool.cjs');
const clockDefault = { now: () => performance.now(), setTimeout, clearTimeout };

async function createWorker(config, indices, emit, dependencies = {}) {
  const clock = dependencies.clock || clockDefault, connect = dependencies.connect || io, fetchImpl = dependencies.fetchImpl || fetch;
  const { timing } = config;
  const sockets = new Map(), entries = new Map(), pending = new Set(), timers = new Set();
  const controllers = new Set(), finalizers = new Set();
  let closing = false, disconnected = false;
  const cpuStart = process.threadCpuUsage();
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const timer = (fn, ms) => {
    const id = clock.setTimeout(() => { timers.delete(id); fn(); }, Math.max(0, ms)); timers.add(id); return id;
  };
  const clear = id => { clock.clearTimeout(id); timers.delete(id); };
  const sleepUntil = at => new Promise(resolve => timer(resolve, at - clock.now()));
  const stamp = () => performance.timeOrigin + clock.now();
  const record = row => emit({ at: stamp(), ...row });
  function observation(index, message) {
    const entry = entries.get(message?.body);
    if (!entry || message.conversationId !== entry.conversationId || message.senderId !== config.users[entry.index].id || !message.id) return;
    const role = index === entry.index ? 'echo' : index === (entry.index ^ 1) ? 'recipient' : null;
    if (!role) return;
    if (entry.seen[role]) { record({ type: 'duplicate', index, message: entry.key, role }); return; }
    entry.seen[role] = true;
    if (clock.now() - entry.started > timing.timeoutMs || entry.finalized) return;
    entry[role] = { id: message.id, ms: clock.now() - entry.started, at: stamp() };
    entry.maybeFinish();
  }
  async function open(index) {
    const user = config.users[index];
    const socket = connect(config.socketTarget || config.target, { autoConnect: false, auth: { token: user.token },
      path: config.socketPath || '/socket.io', transports: ['websocket'], reconnection: false, forceNew: true, timeout: timing.timeoutMs });
    const item = { socket, active: false }; sockets.set(index, item);
    socket.on('message:created', message => observation(index, message));
    socket.on('disconnect', () => {
      if (item.active) { item.active = false; record({ type: 'socket_close', index }); }
      if (!closing) { disconnected = true; record({ type: 'disconnect', index }); }
    });
    await new Promise((resolve, reject) => {
      const finish = error => {
        clear(deadline); socket.off('connect', ready); socket.off('connect_error', failed);
        error ? reject(error) : resolve();
      };
      const ready = () => { item.active = true; record({ type: 'socket_open', index }); finish(); };
      const failed = () => finish(new Error('socket_connect_failed'));
      const deadline = timer(failed, timing.timeoutMs);
      socket.once('connect', ready); socket.once('connect_error', failed); socket.connect();
    });
  }
  function send(index, slot, scheduledAt, lag) {
    const user = config.users[index], key = `${index}/${slot}`, body = `[bench ${config.runId}/${key}]`;
    const entry = { key, index, conversationId: user.conversationId, scheduledAt, started: clock.now(),
      seen: {}, httpDone: false, posted: false, finalized: false, lag };
    entries.set(body, entry);
    const controller = new AbortController(); controllers.add(controller);
    const operation = new Promise(resolve => {
      const finish = () => {
        if (entry.finalized) return;
        entry.finalized = true; clear(deadline); controller.abort(); controllers.delete(controller); finalizers.delete(finish);
        record({ type: 'message', index, key, scheduledAt, attempted: true, lag, posted: entry.posted,
          apiMs: entry.apiMs, postedAt: entry.postedAt, status: entry.status,
          recipientObserved: Boolean(entry.recipient), echoObserved: Boolean(entry.echo),
          recipientObservation: entry.recipient, echoObservation: entry.echo,
          recipient: entry.posted && entry.recipient?.id === entry.id ? entry.recipient : null,
          echo: entry.posted && entry.echo?.id === entry.id ? entry.echo : null,
          ambiguous: !entry.posted && Boolean(entry.recipient || entry.echo) });
        entries.set(body, { key, index, conversationId: entry.conversationId, seen: entry.seen, finalized: true });
        resolve();
      };
      entry.maybeFinish = () => { if (entry.httpDone && entry.recipient && entry.echo) finish(); };
      const deadline = timer(finish, timing.timeoutMs);
      finalizers.add(finish);
      (async () => {
        try {
          const response = await fetchImpl(`${config.target}/api/conversations/${user.conversationId}/messages`, {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
          const data = await response.json();
          if (entry.finalized) return;
          entry.status = response.status;
          entry.apiMs = clock.now() - entry.started;
          if (response.status === 201 && data.message?.id) {
            entry.posted = true; entry.id = data.message.id; entry.postedAt = stamp();
          }
        } catch { /* An unknown HTTP outcome can still have socket observations. */ }
        finally { entry.httpDone = true; entry.maybeFinish(); }
      })();
    });
    pending.add(operation); operation.finally(() => pending.delete(operation));
    return operation;
  }
  return {
    async ramp(rampStart) {
      // Local queues are bounded; complete pairs always stay in one thread.
      await mapLimit(indices, Math.max(1, Math.floor(timing.connectConcurrency / config.workers)), async index => {
        await sleepUntil(rampStart + index * timing.rampMs / config.users.length);
        await open(index);
      });
      await sleepUntil(rampStart + timing.rampMs);
      if (disconnected || [...sockets.values()].some(s => !s.active)) throw new Error('not_ready');
    },
    async measure(start) {
      if (disconnected || sockets.size !== indices.length || [...sockets.values()].some(s => !s.active)) throw new Error('not_ready');
      await sleepUntil(start);
      record({ type: 'measurement_start', start: performance.timeOrigin + start, end: performance.timeOrigin + start + timing.measureMs });
      const inFlight = new Map(indices.map(i => [i, 0]));
      await Promise.all(indices.map(async index => {
        const slots = schedule(config.seed, index, timing);
        for (let slot = 0; slot < slots.length; slot++) {
          const deadline = start + slots[slot]; await sleepUntil(deadline);
          const lag = Math.max(0, clock.now() - deadline), scheduledAt = performance.timeOrigin + deadline;
          const missed = lag > timing.lateMs || clock.now() >= start + timing.measureMs;
          if (missed || inFlight.get(index) >= timing.maxPending) {
            record({ type: 'message', index, key: `${index}/${slot}`, scheduledAt, lag, attempted: false,
              missed, limit: inFlight.get(index) >= timing.maxPending });
            continue;
          }
          inFlight.set(index, inFlight.get(index) + 1);
          send(index, slot, scheduledAt, lag).finally(() => inFlight.set(index, inFlight.get(index) - 1));
        }
      }));
      await sleepUntil(start + timing.measureMs);
      record({ type: 'measurement_end' });
      let drain;
      await Promise.race([Promise.all([...pending]), new Promise(resolve => { drain = timer(resolve, timing.drainMs); })]);
      clear(drain);
    },
    async close() {
      closing = true;
      for (const finish of [...finalizers]) finish();
      for (const controller of controllers) controller.abort();
      for (const id of timers) clock.clearTimeout(id); timers.clear();
      for (const [index, item] of sockets) {
        if (item.active) { item.active = false; record({ type: 'socket_close', index }); }
        item.socket.disconnect(); item.socket.removeAllListeners();
      }
      entries.clear(); loop.disable();
      const cpu = process.threadCpuUsage(cpuStart);
      record({ type: 'health', cpuMicros: cpu, cpuScope: 'thread',
        eventLoopMs: { p95: loop.percentile(95) / 1e6, max: loop.max / 1e6 } });
    },
  };
}

if (!isMainThread) {
  const { config, indices, workerIndex } = workerData;
  const stream = fs.createWriteStream(require('node:path').join(config.traceDir, `pool-${workerIndex}.jsonl`), { mode: 0o600 });
  let buffer = '', flushTimer;
  const flush = () => { if (buffer) { stream.write(buffer); buffer = ''; } };
  (async () => {
    const worker = await createWorker(config, indices, row => {
      buffer += `${JSON.stringify({ worker: workerIndex, ...row })}\n`;
      if (buffer.length >= 65536) flush();
      if (row.type === 'message') {
        parentPort.postMessage({ metric: 'counter', name: 'pool.scheduled', value: 1 });
        for (const [field, name] of [['attempted', 'attempted'], ['posted', 'posted'], ['recipient', 'confirmed'], ['echo', 'echoes'], ['ambiguous', 'ambiguous'], ['missed', 'missed_slots'], ['limit', 'inflight_limit_hits']])
          if (row[field]) parentPort.postMessage({ metric: 'counter', name: `pool.${name}`, value: 1 });
        for (const [name, value] of [['api_ms', row.apiMs], ['recipient_ms', row.recipient?.ms], ['echo_ms', row.echo?.ms], ['dispatch_ms', row.lag]])
          if (Number.isFinite(value)) parentPort.postMessage({ metric: 'histogram', name: `pool.${name}`, value });
      }
      if (row.type === 'socket_open' || row.type === 'socket_close') parentPort.postMessage({ metric: 'counter', name: `pool.${row.type}`, value: 1 });
      if (row.type === 'duplicate' || row.type === 'disconnect') parentPort.postMessage({ metric: 'counter', name: `pool.${row.type}`, value: 1 });
    });
    flushTimer = setInterval(flush, 1000);
    const receive = type => new Promise(resolve => {
      const listener = message => { if (message.type === type) { parentPort.off('message', listener); resolve(message); } };
      parentPort.on('message', listener);
    });
    try {
      const ramp = receive('ramp'); parentPort.postMessage({ type: 'booted' });
      await worker.ramp((await ramp).at);
      const start = receive('start'); parentPort.postMessage({ type: 'ready' });
      await worker.measure((await start).at);
    } catch { buffer += `${JSON.stringify({ type: 'setup_failure', worker: workerIndex, at: Date.now() })}\n`; }
    finally {
      await worker.close(); clearInterval(flushTimer); flush();
      await new Promise(resolve => stream.end(resolve));
      parentPort.postMessage({ type: 'done' }); parentPort.close();
    }
  })().catch(() => { clearInterval(flushTimer); stream.destroy(); process.exitCode = 1; parentPort.close(); });
}
module.exports = { createWorker };
