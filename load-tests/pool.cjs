const { createHash } = require('node:crypto');
const VERSION = 'distinct-pool-v1';
const THRESHOLDS = { apiP95Ms: 500, recipientP95Ms: 200, dispatchP95Ms: 50 };
const TIMING = { rampMs: 120000, measureMs: 300000, graceMs: 15000, timeoutMs: 10000,
  drainMs: 10000, intervalMinMs: 3000, intervalMaxMs: 5000, maxPending: 4, lateMs: 100, connectConcurrency: 16 };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let v = Math.imul(state ^ state >>> 15, 1 | state);
    v ^= v + Math.imul(v ^ v >>> 7, 61 | v);
    return ((v ^ v >>> 14) >>> 0) / 4294967296;
  };
}
function selectAccounts(accounts, count, seed) {
  if (!Number.isSafeInteger(count) || count < 2 || count % 2 || count > accounts.length) throw new Error('Clients must be an even count >= 2 within the account pool.');
  // Canonical ordering makes a saved pool's file ordering irrelevant.
  const shuffled = [...accounts].sort((a, b) => a.username.localeCompare(b.username, 'en'));
  const rng = random(seed);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}
function schedule(seed, index, timing) {
  const rng = random((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  const slots = [];
  let at = Math.floor(rng() * timing.intervalMaxMs);
  while (at < timing.measureMs) {
    slots.push(at);
    at += Math.floor(timing.intervalMinMs + rng() * (timing.intervalMaxMs - timing.intervalMinMs + 1));
  }
  return slots;
}
function partition(users, workers) {
  const groups = Array.from({ length: Math.min(workers, users.length / 2) }, () => []);
  for (let i = 0; i < users.length; i += 2) groups[(i / 2) % groups.length].push(i, i + 1);
  return groups;
}
async function mapLimit(items, limit, fn) {
  const result = new Array(items.length); let next = 0, failure;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure) {
      const i = next++;
      if (i >= items.length) break;
      try { result[i] = await fn(items[i], i); } catch (error) { failure = error; }
    }
  }));
  if (failure) throw failure;
  return result;
}
module.exports = { VERSION, THRESHOLDS, TIMING, hash, random, selectAccounts, schedule, partition, mapLimit };
