import { io } from 'socket.io-client';
import { getAuthenticatedSession } from './authService';

const socketUrl = import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_API_URL || 'http://localhost:3000';

export async function connectChatSocket(onMessage) {
  const { idToken } = await getAuthenticatedSession();
  const socket = io(socketUrl, { auth: { token: idToken } });
  socket.on('message:created', onMessage);
  return socket;
}
