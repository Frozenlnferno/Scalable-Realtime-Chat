import { pool } from "../../core/database/pool.js";

const columns = `id, conversation_id AS "conversationId", sender_id AS "senderId",
  body, created_at AS "createdAt"`;

export async function create({ conversationId, senderId, body }) {
  const result = await pool.query(
    `INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1, $2, $3) RETURNING ${columns}`,
    [conversationId, senderId, body],
  );
  await pool.query("UPDATE conversations SET updated_at = NOW() WHERE id = $1", [conversationId]);
  return result.rows[0];
}

export async function listByConversation(conversationId, cursor, limit) {
  const values = [conversationId];
  let condition = "";
  if (cursor) {
    values.push(cursor.createdAt, cursor.id);
    condition = "AND (created_at, id) < ($2::timestamptz, $3::uuid)";
  }
  values.push(limit + 1);
  const result = await pool.query(
    `SELECT ${columns} FROM messages
     WHERE conversation_id = $1 ${condition}
     ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}
