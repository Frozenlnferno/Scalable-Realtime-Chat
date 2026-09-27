import { pool } from "../../core/database/pool.js";

const columns = `id, user_one_id AS "userOneId", user_two_id AS "userTwoId",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function createOrFindDirectConversation(firstUserId, secondUserId) {
  const result = await pool.query(
    `INSERT INTO conversations (user_one_id, user_two_id)
     VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))
     ON CONFLICT (user_one_id, user_two_id) DO UPDATE SET updated_at = conversations.updated_at
     RETURNING ${columns}`,
    [firstUserId, secondUserId],
  );
  return result.rows[0];
}

export async function findForParticipant(conversationId, userId) {
  const result = await pool.query(
    `SELECT ${columns} FROM conversations
     WHERE id = $1 AND (user_one_id = $2 OR user_two_id = $2)`,
    [conversationId, userId],
  );
  return result.rows[0] || null;
}
