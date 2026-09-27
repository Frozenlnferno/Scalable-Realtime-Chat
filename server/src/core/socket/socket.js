import { Server } from "socket.io";
import { getAuthenticatedUser } from "../auth/authenticate.js";
import { setSocketServer } from "./socket.events.js";

export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: process.env.CLIENT_ORIGIN || "http://localhost:5173", methods: ["GET", "POST"] },
  });
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("Authentication required."));
      socket.user = await getAuthenticatedUser(token);
      next();
    } catch (_error) {
      next(new Error("Authentication required."));
    }
  });
  io.on("connection", (socket) => socket.join(`user:${socket.user.id}`));
  setSocketServer(io);
  return io;
}
