let io;

export function setSocketServer(server) {
  io = server;
}

export function emitMessageCreated(message, participantIds) {
  for (const userId of participantIds) io?.to(`user:${userId}`).emit("message:created", message);
}
