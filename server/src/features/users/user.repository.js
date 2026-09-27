import { pool } from "../../core/database/pool.js";

const columns = "id, cognito_sub AS \"cognitoSub\", email, created_at AS \"createdAt\"";

export async function upsert({ cognitoSub, email }) {
  const result = await pool.query(
    `INSERT INTO users (cognito_sub, email)
     VALUES ($1, $2)
     ON CONFLICT (cognito_sub) DO UPDATE SET email = EXCLUDED.email, updated_at = NOW()
     RETURNING ${columns}`,
    [cognitoSub, email],
  );
  return result.rows[0];
}

export async function listExcept(userId) {
  const result = await pool.query(
    `SELECT ${columns} FROM users WHERE id <> $1 ORDER BY email ASC`,
    [userId],
  );
  return result.rows;
}

export async function findById(id) {
  const result = await pool.query(`SELECT ${columns} FROM users WHERE id = $1`, [id]);
  return result.rows[0] || null;
}
