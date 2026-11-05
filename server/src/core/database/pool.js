import "dotenv/config";
import pg from "pg";
import { createDatabase, databaseSettings, observePoolErrors } from "./client.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Start Docker Compose or configure PostgreSQL.");
}

const settings = databaseSettings();
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL,
  max: settings.DB_POOL_MAX, connectionTimeoutMillis: settings.DB_POOL_ACQUIRE_TIMEOUT_MS,
  statement_timeout: settings.DB_STATEMENT_TIMEOUT_MS, lock_timeout: settings.DB_LOCK_TIMEOUT_MS });
observePoolErrors(pool);
export const { query } = createDatabase(pool, settings);
