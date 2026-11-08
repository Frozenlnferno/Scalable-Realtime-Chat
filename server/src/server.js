import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { createSocketServer } from "./core/socket/socket.js";

const app = createApp();
const httpServer = createServer(app);
const port = Number(process.env.PORT || 3000);

async function start() {
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
