import cors from "cors";
import express from "express";
import { pool } from "./core/database/pool.js";
import { requestTiming } from "./core/diagnostics/request-timing.js";
import { authenticateRequest } from "./core/auth/authenticate.js";
import conversationRoutes from "./features/conversations/conversation.routes.js";
import messageRoutes from "./features/messages/message.routes.js";
import userRoutes from "./features/users/user.routes.js";

export function createApp({ authenticate = authenticateRequest, timing = requestTiming({ pool }),
  users = userRoutes, conversations = conversationRoutes, messages = messageRoutes } = {}) {
  const app = express();
  app.use(timing);
  app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));
  app.use(express.json({ limit: "16kb" }));
  app.get("/", (_req, res) => res.json({ message: "Chat API is running." }));
  app.use("/api/users", authenticate, users);
  app.use("/api/conversations", authenticate, conversations, messages);
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    // Expected overload is covered by bounded timing logs; avoid a log storm.
    if (status >= 500 && status !== 503) console.error(JSON.stringify({ event: "request_error", status, code: "unexpected_error" }));
    res.status(status).json({ message: status === 503
      ? "The service is temporarily unavailable. Please try again later."
      : error.message || "An unexpected error occurred." });
  });
  return app;
}
