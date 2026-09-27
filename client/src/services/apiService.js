import { getAuthenticatedSession } from './authService';

const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';

async function request(path, options = {}) {
  const { idToken } = await getAuthenticatedSession();
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${idToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || 'The request could not be completed.');
  return payload;
}

export const getUsers = () => request('/api/users');
export const openDirectConversation = (recipientUserId) => request('/api/conversations/direct', {
  method: 'POST', body: JSON.stringify({ recipientUserId }),
});
export const getMessages = (conversationId) => request(`/api/conversations/${conversationId}/messages`);
export const createMessage = (conversationId, body) => request(`/api/conversations/${conversationId}/messages`, {
  method: 'POST', body: JSON.stringify({ body }),
});
