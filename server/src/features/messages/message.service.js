import { emitMessageCreated } from "../../core/socket/socket.events.js";
import { requireParticipant } from "../conversations/conversation.service.js";
import * as messages from "./message.repository.js";

const MAX_PAGE_SIZE = 50;

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!decoded.createdAt || !decoded.id || Number.isNaN(new Date(decoded.createdAt).getTime())) throw new Error();
    return decoded;
  } catch {
    throw badRequest("Invalid message cursor.");
  }
}

export async function getMessages(conversationId, userId, cursor) {
  await requireParticipant(conversationId, userId);
  const rows = await messages.listByConversation(conversationId, decodeCursor(cursor), MAX_PAGE_SIZE);
  const hasMore = rows.length > MAX_PAGE_SIZE;
  const page = rows.slice(0, MAX_PAGE_SIZE);
  const last = page.at(-1);
  return {
    messages: page.reverse(),
    nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString("base64url") : null,
  };
}

export async function sendMessage(conversationId, senderId, body) {
  const text = typeof body === "string" ? body.trim() : "";
  if (!text || text.length > 4000) throw badRequest("Messages must contain between 1 and 4000 characters.");
  const conversation = await requireParticipant(conversationId, senderId);
  const message = await messages.create({ conversationId, senderId, body: text });
  emitMessageCreated(message, [conversation.userOneId, conversation.userTwoId]);
  return message;
}
