import { Server } from "socket.io";
import { randomUUID } from "node:crypto";

export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on("chat:message", (message) => {
      io.emit("chat:message", {
        ...message,
        id: message?.id || randomUUID(),
        sentAt: message?.sentAt || new Date().toISOString(),
      });
    });

    socket.on("disconnect", (reason) => {
      console.log(`Socket disconnected: ${socket.id} (${reason})`);
    });
  });

  return io;
}
