import express from "express";
import { createServer } from "node:http";

import chatRoutes from "./features/chat/chat.routes.js";
import { createSocketServer } from "./socket/socket.js";

import dotenv from "dotenv";
dotenv.config();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3000;

createSocketServer(httpServer);

app.use(express.json());

app.get("/", (req, res) => {
  res.json({"message": "Server is up and running!"});
});

app.use("/api/chat", chatRoutes);

httpServer.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
