import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";

const requests = new AsyncLocalStorage();
const round = (value) => Math.round(value * 100) / 100;

export function requestTiming({ pool, enabled = process.env.REQUEST_TIMING_ENABLED === "true",
  slowMs = Number(process.env.REQUEST_TIMING_SLOW_MS || 500), logger = console.log,
  now = () => performance.now() } = {}) {
  if (!Number.isFinite(slowMs) || slowMs < 0) throw new Error("REQUEST_TIMING_SLOW_MS must be a non-negative number.");
  // Bound diagnostic output to one slow/failed request per second per process.
  let lastLog = -Infinity, suppressed = 0;
  return (req, res, next) => {
    if (!enabled) return next();
    const state = { started: now(), now, waitMs: 0, queryMs: 0, calls: 0, operations: {}, errors: {}, active: new Set() };
    let recorded = false;
    const finish = (aborted) => {
      if (recorded) return;
      recorded = true;
      const ended = now(), durationMs = ended - state.started;
      if (!aborted && res.statusCode < 500 && durationMs < slowMs) return;
      if (ended - lastLog < 1000) { suppressed++; return; }
      lastLog = ended;
      let waitMs = state.waitMs, queryMs = state.queryMs;
      for (const op of state.active) {
        if (op.phase === "wait") waitMs += ended - op.started;
        else queryMs += ended - op.started;
      }
      logger(JSON.stringify({ event: "request_timing", timestamp: new Date().toISOString(),
        instance: hostname(), pid: process.pid, requestId: randomUUID(), method: req.method,
        route: typeof req.route?.path === "string" ? req.route.path : "unmatched",
        status: aborted && !res.headersSent ? null : res.statusCode, aborted, durationMs: round(durationMs),
        dbWaitMs: round(waitMs), dbQueryMs: round(queryMs), dbCalls: state.calls,
        dbPending: state.active.size, dbErrors: state.errors,
        dbOutstanding: [...state.active].map(op => ({ operation: op.operation, phase: op.phase, elapsedMs: round(ended - op.started) })),
        dbOperations: Object.fromEntries(Object.entries(state.operations).map(([name, op]) =>
          [name, { calls: op.calls, errors: op.errors, waitMs: round(op.waitMs), queryMs: round(op.queryMs) }])),
        pool: { max: pool.options?.max, total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
        suppressedSinceLastLog: suppressed }));
      suppressed = 0;
    };
    res.once("finish", () => finish(false));
    res.once("close", () => finish(!res.writableFinished));
    requests.run(state, next);
  };
}

// Repository queries use static operation names, never SQL or parameter values in logs.
export function withDatabaseTiming(operation, work) {
  const state = requests.getStore();
  if (!state) return work(() => {});
  return (async () => {
    const metric = state.operations[operation] ||= { calls: 0, errors: 0, waitMs: 0, queryMs: 0 };
    state.calls++; metric.calls++;
    const active = { operation, phase: "wait", started: state.now() };
    state.active.add(active);
    const acquired = () => {
      const duration = state.now() - active.started;
      state.waitMs += duration; metric.waitMs += duration;
      active.phase = "query"; active.started = state.now();
    };
    try {
      return await work(acquired);
    } catch (error) {
      metric.errors++;
      const code = ["db_overloaded", "db_acquire_timeout", "db_statement_timeout", "db_lock_timeout", "db_unavailable"].includes(error?.diagnosticCode)
        ? error.diagnosticCode : "db_error";
      state.errors[code] = (state.errors[code] || 0) + 1;
      throw error;
    } finally {
      const duration = state.now() - active.started;
      if (active.phase === "wait") { state.waitMs += duration; metric.waitMs += duration; }
      else { state.queryMs += duration; metric.queryMs += duration; }
      state.active.delete(active);
    }
  })();
}
