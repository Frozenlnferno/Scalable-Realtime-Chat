import { query } from "../../core/database/pool.js";

const columns = "id, cognito_sub AS \"cognitoSub\", email, created_at AS \"createdAt\"";

export async function upsert({ cognitoSub, email }) {
  const existing = await query("users.resolve", `SELECT ${columns} FROM users WHERE cognito_sub = $1`, [cognitoSub]);
  if (existing.rows[0]?.email === email) return existing.rows[0];
  const result = await query("users.upsert",
    `INSERT INTO users (cognito_sub, email)
     VALUES ($1, $2)
     ON CONFLICT (cognito_sub) DO UPDATE SET email = EXCLUDED.email, updated_at = NOW()
     RETURNING ${columns}`,
    [cognitoSub, email],
  );
  return result.rows[0];
}

export async function listExcept(userId) {
  const result = await query("users.list",
    `SELECT ${columns} FROM users WHERE id <> $1 ORDER BY email ASC`,
    [userId],
  );
  return result.rows;
}

export async function findById(id) {
  const result = await query("users.find", `SELECT ${columns} FROM users WHERE id = $1`, [id]);
  return result.rows[0] || null;
}
