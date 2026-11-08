import { withDatabaseTiming } from "../diagnostics/request-timing.js";

export function databaseSettings(env = process.env) {
  const defaults = { DB_POOL_MAX: 10, DB_POOL_MAX_WAITING: 100, DB_POOL_ACQUIRE_TIMEOUT_MS: 2000,
    DB_STATEMENT_TIMEOUT_MS: 5000, DB_LOCK_TIMEOUT_MS: 1000 };
  const settings = {};
  for (const [name, fallback] of Object.entries(defaults)) {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < (name === "DB_POOL_MAX_WAITING" ? 0 : 1)) {
      throw new Error(`${name} must be an integer ${name === "DB_POOL_MAX_WAITING" ? ">= 0" : "> 0"}.`);
    }
    settings[name] = value;
  }
  if (settings.DB_LOCK_TIMEOUT_MS >= settings.DB_STATEMENT_TIMEOUT_MS) {
    throw new Error("DB_LOCK_TIMEOUT_MS must be less than DB_STATEMENT_TIMEOUT_MS.");
  }
  return settings;
}

export function unavailable(code) {
  return Object.assign(new Error("The service is temporarily unavailable. Please try again later."),
    { status: 503, diagnosticCode: code });
}

export function databaseError(error) {
  if (error?.status) return error;
  if (error?.code === "57014") return unavailable("db_statement_timeout");
  if (error?.code === "55P03") return unavailable("db_lock_timeout");
  if (/^08[0-9A-Z]{3}$/.test(error?.code || "") ||
      ["53300", "57P01", "57P02", "57P03", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"].includes(error?.code) ||
      ["Connection terminated unexpectedly", "Connection terminated"].includes(error?.message)) {
    return unavailable("db_unavailable");
  }
  return error;
}

export function createDatabase(pool, settings) {
  const query = (operation, text, values) => withDatabaseTiming(operation, async (acquired) => {
    if (pool.idleCount === 0 && pool.totalCount >= settings.DB_POOL_MAX &&
        pool.waitingCount >= settings.DB_POOL_MAX_WAITING) throw unavailable("db_overloaded");
    let client;
    try { client = await pool.connect(); }
    catch (error) {
      if (["timeout exceeded when trying to connect", "Connection terminated due to connection timeout"].includes(error?.message)) {
        throw unavailable("db_acquire_timeout");
      }
      throw databaseError(error);
    }
    acquired();
    let queryError, onError;
    try {
      return await new Promise((resolve, reject) => {
        onError = reject;
        client.once("error", onError);
        Promise.resolve(client.query(text, values)).then(resolve, reject);
      });
    } catch (error) {
      queryError = error;
      throw databaseError(error);
    } finally {
      client.removeListener("error", onError);
      client.release(queryError);
    }
  });
  return { query };
}

export function observePoolErrors(pool, logger = console.error) {
  pool.on("error", () => logger(JSON.stringify({ event: "database_pool_error", code: "db_unavailable" })));
}
