import "dotenv/config";
import cors from "cors";
import express from "express";
import { createServer } from "node:http";

import { runMigrations } from "./core/database/migrate.js";
import { authenticateRequest } from "./core/auth/authenticate.js";
import { createSocketServer } from "./core/socket/socket.js";
import conversationRoutes from "./features/conversations/conversation.routes.js";
import messageRoutes from "./features/messages/message.routes.js";
import userRoutes from "./features/users/user.routes.js";

const app = express();
const httpServer = createServer(app);
const port = Number(process.env.PORT || 3000);

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "16kb" }));
app.get("/", (_req, res) => res.json({ message: "Chat API is running." }));
app.use("/api/users", authenticateRequest, userRoutes);
app.use("/api/conversations", authenticateRequest, conversationRoutes);
app.use("/api/conversations", authenticateRequest, messageRoutes);

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ message: error.message || "An unexpected error occurred." });
});

async function start() {
  await runMigrations();
  const io = await createSocketServer(httpServer);
  let closing = false;
  const closeSockets = async () => {
    if (closing) return;
    closing = true;
    await io.close();
    process.exit(0);
  };
  process.once("SIGINT", closeSockets);
  process.once("SIGTERM", closeSockets);
  httpServer.listen(port, () => console.log(`Server is running on port ${port}`));
}

start().catch((error) => {
  console.error("Unable to start server:", error);
  process.exit(1);
});
