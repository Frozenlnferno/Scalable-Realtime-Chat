import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import "dotenv/config";
import pg from "pg";

// Migrations must not inherit application statement/lock timeouts.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to run migrations.");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const directory = join(dirname(fileURLToPath(import.meta.url)), "../../../migrations");

export async function runMigrations() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const applied = await pool.query("SELECT filename FROM schema_migrations");
  const completed = new Set(applied.rows.map((row) => row.filename));
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();

  for (const filename of files) {
    if (completed.has(filename)) continue;
    const sql = await readFile(join(directory, filename), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
      await client.query("COMMIT");
      console.log(`Applied migration ${filename}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations().then(() => pool.end()).catch(async (error) => {
    console.error("Migration failed:", error);
    await pool.end();
    process.exit(1);
  });
}
