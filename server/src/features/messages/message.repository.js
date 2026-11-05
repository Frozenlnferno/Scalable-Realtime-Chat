import { query } from "../../core/database/pool.js";

const columns = `id, conversation_id AS "conversationId", sender_id AS "senderId",
  body, created_at AS "createdAt"`;

export async function create({ conversationId, senderId, body }) {
  const result = await query("messages.insert_and_touch",
    `WITH inserted AS (
       INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1, $2, $3) RETURNING ${columns}
     ), touched AS (
       UPDATE conversations SET updated_at = NOW()
       WHERE id = $1 AND EXISTS (SELECT 1 FROM inserted) RETURNING id
     )
     SELECT inserted.* FROM inserted CROSS JOIN touched`,
    [conversationId, senderId, body],
  );
  if (!result.rows[0]) throw new Error("Message persistence did not return a message.");
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
  const result = await query("messages.history",
    `SELECT ${columns} FROM messages
     WHERE conversation_id = $1 ${condition}
     ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}
