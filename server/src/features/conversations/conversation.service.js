import * as conversations from "./conversation.repository.js";
import { findById } from "../users/user.repository.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export async function openDirectConversation(userId, recipientId) {
  if (!uuidPattern.test(recipientId || "") || recipientId === userId) throw badRequest("Choose another user to start a conversation.");
  if (!(await findById(recipientId))) throw badRequest("The selected user no longer exists.");
  return conversations.createOrFindDirectConversation(userId, recipientId);
}

export async function requireParticipant(conversationId, userId) {
  if (!uuidPattern.test(conversationId || "")) {
    const error = new Error("Conversation not found.");
    error.status = 404;
    throw error;
  }
  const conversation = await conversations.findForParticipant(conversationId, userId);
  if (!conversation) {
    const error = new Error("Conversation not found.");
    error.status = 404;
    throw error;
  }
  return conversation;
}
