const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { io } = require('socket.io-client');
const { runtime, makeCase, trace, validateResponse, safeError } = require('./benchmark.cjs');

const clockDefault = {
  now: () => performance.now(), setTimeout: (...args) => setTimeout(...args), clearTimeout: id => clearTimeout(id),
};
function sleep(ms, signal, clock = clockDefault) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const finish = error => { clock.clearTimeout(timer); signal?.removeEventListener('abort', aborted); error ? reject(error) : resolve(); };
    const aborted = () => finish(signal.reason);
    const timer = clock.setTimeout(() => finish(), Math.max(0, ms));
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function createSession(context, events, config = runtime()) {
  const caseIndex = Number(context.vars.caseIndex);
  if (!Number.isInteger(caseIndex) || caseIndex < 0) throw new Error('Use_npm_run_bench_for_this_scenario');
  const selected = makeCase(config.seed, caseIndex, config.users.length, config.timing);
  const state = { config, selected, id: randomUUID(), started: performance.now(), closed: false };
  context._bench = state;
  Object.assign(context.vars, {
    senderToken: config.users[selected.sender].token,
    recipientUserId: config.users[selected.recipient].id,
    runId: `${config.runId}/${state.id}`,
  });
  trace(config, { type: 'session_open', session: state.id, caseIndex, sender: selected.sender, recipient: selected.recipient });
  events.emit('counter', 'chat.messages_planned', 5);
  return state;
}

function closeSession(state, success, reason) {
  if (state.closed) return;
  state.closed = true;
  clearTimeout(state.timer);
  trace(state.config, { type: 'session_close', session: state.id, success, ...(reason ? { reason } : {}) });
}

function prepareChat(context, events, done) {
  try {
    const state = createSession(context, events);
    state.timer = setTimeout(() => { state.deadline = true; closeSession(state, false, 'session_deadline'); }, state.config.timing.deadlineMs);
    done();
  } catch { done(new Error('Use_npm_run_bench_for_this_scenario')); }
}

async function pauseMessage(context) {
  const state = context._bench;
  if (!state || state.deadline) throw new Error('session_deadline');
  state.messageIndex = (state.messageIndex || 0) + 1;
  await sleep(state.selected.delays[state.messageIndex - 1]);
  context.vars.messageBody = `[artillery ${context.vars.runId}] ${state.messageIndex}`;
}

function beforeApi(request, context, events, done) {
  const state = context._bench;
  if (state.deadline) return done(new Error('session_deadline'));
  state.request = { id: randomUUID(), endpoint: request.name, started: performance.now() };
  trace(state.config, { type: 'request_start', session: state.id, request: state.request.id, endpoint: request.name });
  if (request.name === 'send_message') {
    events.emit('counter', 'chat.messages_attempted', 1);
    trace(state.config, { type: 'message_attempted', session: state.id });
  }
  done();
}

function checkResponse(request, response, context, events, done) {
  const state = context._bench;
  let error;
  try {
    validateResponse(request.name, response.statusCode, JSON.parse(response.body));
    if (state?.deadline) throw new Error('session_deadline');
  } catch (caught) { error = caught instanceof SyntaxError ? new Error('unexpected_json_response') : caught; }
  if (state?.request) {
    trace(state.config, { type: 'request_end', session: state.id, request: state.request.id, endpoint: request.name,
      status: response.statusCode, success: !error, durationMs: response.timings?.phases?.firstByte ?? performance.now() - state.request.started });
    state.request = null;
    if (!error && request.name === 'send_message') {
      events.emit('counter', 'chat.messages_sent', 1);
      trace(state.config, { type: 'message_sent', session: state.id });
    }
    if (error) closeSession(state, false, safeError(error));
  }
  done(error);
}

function apiError(error, _request, context, _events, done) {
  const state = context._bench;
  if (state) {
    if (state.request) trace(state.config, { type: 'request_end', session: state.id, request: state.request.id,
      endpoint: state.request.endpoint, success: false, reason: safeError(error) });
    state.request = null;
    closeSession(state, false, safeError(error));
  }
  done();
}

function finishChat(context, _events, done) {
  closeSession(context._bench, true);
  done();
}

async function executeRealtime(context, events, dependencies = {}) {
  const config = dependencies.config || runtime();
  const clock = dependencies.clock || clockDefault;
  const connect = dependencies.connect || io;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const state = createSession(context, events, config);
  const controller = new AbortController();
  const { signal } = controller;
  const sockets = [];
  const expected = new Map();
  let closing = false;
  const count = name => events.emit('counter', name, 1);
  const fail = reason => {
    if (signal.aborted) return;
    const metric = { socket_disconnected: 'chat.unexpected_disconnects', duplicate_delivery: 'chat.duplicates',
      delivery_timeout: 'chat.delivery_timeouts', echo_timeout: 'chat.echo_timeouts', session_deadline: 'chat.deadlines' }[reason];
    if (metric) count(metric);
    trace(config, { type: 'failure', session: state.id, reason });
    controller.abort(new Error(reason));
  };
  const deadline = clock.setTimeout(() => fail('session_deadline'), config.timing.deadlineMs);

  function received(role, message) {
    const entry = expected.get(message?.body);
    if (!entry) return;
    if (message.conversationId !== entry.conversationId || message.senderId !== config.users[state.selected.sender].id || !message.id) {
      fail('message_mismatch'); return;
    }
    if (entry.observed[role]) { fail('duplicate_delivery'); return; }
    const result = { id: message.id, elapsed: clock.now() - entry.started, at: Date.now() };
    entry.observed[role] = result;
    entry.resolve[role]?.(result);
  }

  async function open(role, userIndex) {
    const socket = connect(config.socketTarget || config.target, { autoConnect: false,
      auth: { token: config.users[userIndex].token }, path: config.socketPath || '/socket.io',
      transports: ['websocket'], reconnection: false, forceNew: true, timeout: config.timing.timeoutMs });
    const item = { socket, role, active: false };
    sockets.push(item);
    const close = () => {
      if (!item.active) return;
      item.active = false;
      trace(config, { type: 'socket_close', session: state.id, socket: `${state.id}/${role}` });
    };
    item.close = close;
    socket.on('message:created', message => received(role, message));
    socket.on('disconnect', () => { close(); if (!closing) fail('socket_disconnected'); });
    const started = clock.now();
    await new Promise((resolve, reject) => {
      const finish = error => {
        clock.clearTimeout(timer);
        socket.off('connect', connected); socket.off('connect_error', failed); signal.removeEventListener('abort', aborted);
        error ? reject(error) : resolve();
      };
      const connected = () => {
        item.active = true;
        trace(config, { type: 'socket_open', session: state.id, socket: `${state.id}/${role}` });
        finish();
      };
      const failed = () => finish(new Error('socket_connect_failed'));
      const aborted = () => finish(signal.reason);
      const timer = clock.setTimeout(failed, config.timing.timeoutMs);
      socket.once('connect', connected); socket.once('connect_error', failed);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted(); else socket.connect();
    });
    events.emit('histogram', 'chat.connect_ms', clock.now() - started);
    trace(config, { type: 'timing', session: state.id, metric: 'connect_ms', durationMs: clock.now() - started });
  }

  async function request(endpoint, pathname, body) {
    if (signal.aborted) throw signal.reason;
    const id = randomUUID();
    const started = clock.now();
    trace(config, { type: 'request_start', session: state.id, request: id, endpoint });
    let status;
    try {
      const response = await fetchImpl(`${config.target}${pathname}`, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${config.users[state.selected.sender].token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.timing.timeoutMs)]),
      });
      status = response.status;
      count(`chat.http_status.${status}`);
      const data = validateResponse(endpoint, status, await response.json());
      if (signal.aborted) throw signal.reason;
      const durationMs = clock.now() - started;
      trace(config, { type: 'request_end', session: state.id, request: id, endpoint, status, success: true, durationMs });
      events.emit('histogram', `chat.http_ms.${endpoint}`, durationMs);
      return data;
    } catch (error) {
      trace(config, { type: 'request_end', session: state.id, request: id, endpoint, status, success: false, reason: safeError(error) });
      throw error;
    }
  }

  function waitFor(entry, role) {
    return new Promise(resolve => {
      const finish = value => { clock.clearTimeout(timer); signal.removeEventListener('abort', aborted); resolve(value); };
      const aborted = () => finish({ error: signal.reason });
      const timer = clock.setTimeout(() => fail(role === 'recipient' ? 'delivery_timeout' : 'echo_timeout'), config.timing.timeoutMs);
      entry.resolve[role] = finish;
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }

  try {
    await Promise.all([open('sender', state.selected.sender), open('recipient', state.selected.recipient)]);
    const readyAt = clock.now();
    await request('users', '/api/users');
    const opened = await request('open_conversation', '/api/conversations/direct', { recipientUserId: context.vars.recipientUserId });
    const conversationId = opened.conversation.id;
    await request('history', `/api/conversations/${conversationId}/messages`);
    for (let index = 0; index < 5; index++) {
      await sleep(state.selected.delays[index], signal, clock);
      const body = `[artillery ${context.vars.runId}] ${index + 1}`;
      const entry = { conversationId, started: clock.now(), observed: {}, resolve: {} };
      expected.set(body, entry);
      const delivered = waitFor(entry, 'recipient');
      const echoed = waitFor(entry, 'sender');
      count('chat.messages_attempted');
      trace(config, { type: 'message_attempted', session: state.id });
      const sent = await request('send_message', `/api/conversations/${conversationId}/messages`, { body });
      count('chat.messages_sent');
      trace(config, { type: 'message_sent', session: state.id });
      await Promise.all([['recipient', delivered], ['sender', echoed]].map(async ([role, pending]) => {
        const result = await pending;
        if (result.error) throw result.error;
        if (result.id !== sent.message.id) throw new Error('message_mismatch');
        const metric = role === 'recipient' ? 'delivery_ms' : 'echo_ms';
        count(role === 'recipient' ? 'chat.messages_received' : 'chat.sender_echoes');
        events.emit('histogram', `chat.${metric}`, result.elapsed);
        trace(config, { type: 'timing', session: state.id, metric, durationMs: result.elapsed, at: result.at });
      }));
    }
    await sleep(config.timing.holdMs - (clock.now() - readyAt), signal, clock);
    if (signal.aborted) throw signal.reason;
    closeSession(state, true);
  } catch (error) {
    count('chat.failures');
    const reason = safeError(error);
    closeSession(state, false, reason);
    throw new Error(reason);
  } finally {
    closing = true;
    if (!signal.aborted) controller.abort(new Error('session_finished'));
    clock.clearTimeout(deadline);
    for (const item of sockets) {
      item.close(); item.socket.disconnect(); item.socket.removeAllListeners();
    }
  }
}

async function realtimeChat(context, events) { await executeRealtime(context, events); }
function benchmarkReady(_context, _events, done) { done(); }
if (process.env.BENCH_RUNTIME_FILE && global.artillery?.globalEvents) {
  global.artillery.globalEvents.on('phaseStarted', phase => {
    trace(runtime(), { type: 'phase', index: phase.index, name: phase.name, at: phase.startTime || Date.now() });
  });
}

module.exports = { prepareChat, beforeApi, checkResponse, apiError, finishChat, pauseMessage,
  realtimeChat, executeRealtime, sleep, benchmarkReady };
