const fs = require('node:fs');
const path = require('node:path');
const { threadId } = require('node:worker_threads');

const PROFILES = {
  small: [{ duration: 4, arrivalCount: 4, name: 'Small baseline' }],
  load: [
    { duration: 60, arrivalCount: 6, name: 'Warm up' },
    { duration: 120, arrivalCount: 60, name: 'Build' },
    { duration: 300, arrivalRate: 1, name: 'Steady' },
  ],
};
const DEFAULT_TIMING = { delayMinMs: 2000, delayMaxMs: 8000, holdMs: 60000, timeoutMs: 10000, deadlineMs: 120000 };
let cached;

function runtime() {
  if (!process.env.BENCH_RUNTIME_FILE) throw new Error('Use_npm_run_bench_for_this_scenario');
  return cached ||= JSON.parse(fs.readFileSync(process.env.BENCH_RUNTIME_FILE, 'utf8'));
}

// A stable case number comes from a generated non-secret Artillery CSV payload.
function makeCase(seed, index, accountCount, timing = DEFAULT_TIMING) {
  let state = (Number(seed) ^ Math.imul(Number(index) + 1, 0x9e3779b1)) >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const sender = Math.floor(random() * accountCount);
  let recipient = Math.floor(random() * (accountCount - 1));
  if (recipient >= sender) recipient++;
  const delays = Array.from({ length: 5 }, () => Math.floor(timing.delayMinMs + random() * (timing.delayMaxMs - timing.delayMinMs + 1)));
  return { sender, recipient, delays };
}

function trace(config, record) {
  if (!config.traceDir) return;
  const entry = { at: Date.now(), worker: `${process.pid}-${threadId}`, ...record };
  fs.appendFileSync(path.join(config.traceDir, `${process.pid}-${threadId}.jsonl`), `${JSON.stringify(entry)}\n`);
}

function validateResponse(name, status, body) {
  if (status !== (name === 'send_message' ? 201 : 200)) throw new Error(`unexpected_http_${status}`);
  const valid = {
    users: () => body.currentUser?.id && Array.isArray(body.users),
    open_conversation: () => body.conversation?.id,
    history: () => Array.isArray(body.messages),
    send_message: () => body.message?.id,
  }[name];
  if (!valid?.()) throw new Error('unexpected_json_response');
  return body;
}

function safeError(error) {
  const message = error?.message || '';
  return /^(unexpected_http_\d{3}|unexpected_json_response|socket_connect_failed|socket_disconnected|delivery_timeout|echo_timeout|duplicate_delivery|message_mismatch|session_deadline|Use_npm_run_bench_for_this_scenario)$/.test(message)
    ? message : 'request_or_session_failed';
}

module.exports = { PROFILES, DEFAULT_TIMING, runtime, makeCase, trace, validateResponse, safeError };
