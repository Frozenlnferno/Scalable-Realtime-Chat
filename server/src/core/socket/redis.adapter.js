import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";

const CONNECT_TIMEOUT_MS = 10_000;

// The HTTP server's close event is also triggered by Socket.IO's io.close().
export async function configureSocketAdapter(io, {
  redisUrl = process.env.REDIS_URL,
  keyPrefix = process.env.REDIS_KEY_PREFIX || "chat:socket.io",
  logger = console,
} = {}) {
  if (!redisUrl?.trim()) {
    logger.info("Socket.IO is using the in-memory adapter (REDIS_URL is unset).");
    return;
  }

  const clients = [];
  let stopped = false;
  let timeout;
  let onReady;
  let collectSubscriptions = false;
  const subscriptions = [];
  const disconnect = () => {
    if (stopped) return;
    stopped = true;
    for (const client of clients) client.disconnect();
  };

  try {
    const connectionUrl = redisUrl.trim();
    const url = new URL(connectionUrl);
    if (!["redis:", "rediss:"].includes(url.protocol) || !url.hostname) throw new Error();

    const publisher = new Redis(connectionUrl, {
      lazyConnect: true,
      connectTimeout: CONNECT_TIMEOUT_MS,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      autoResubscribe: true,
      autoResendUnfulfilledCommands: false,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
      ...(url.protocol === "rediss:" ? { tls: { servername: url.hostname, minVersion: "TLSv1.2" } } : {}),
    });
    clients.push(publisher);
    const subscriber = publisher.duplicate();
    clients.push(subscriber);

    for (const [index, client] of clients.entries()) {
      const role = index === 0 ? "publisher" : "subscriber";
      let connectedBefore = false;
      let reportedLoss = false;
      const reportLoss = () => {
        if (stopped || reportedLoss) return;
        reportedLoss = true;
        // Never log connection errors or URLs: they may contain credentials.
        logger.warn(`Redis ${role} connection unavailable; cross-instance broadcasts are interrupted. Retrying.`);
      };
      client.on("error", reportLoss);
      client.on("close", reportLoss);
      // The adapter fires these commands without handling their promises.
      // Observe failures so outages/shutdown cannot cause unhandled rejections.
      // Return the original promise so startup can still reject on ACL errors.
      const methods = index === 0 ? ["publish"] : ["subscribe", "psubscribe", "unsubscribe", "punsubscribe"];
      for (const method of methods) {
        const execute = client[method].bind(client);
        client[method] = (...args) => {
          const result = execute(...args);
          result.catch(reportLoss);
          if (collectSubscriptions && (method === "subscribe" || method === "psubscribe")) subscriptions.push(result);
          return result;
        };
      }
      client.on("ready", () => {
        logger.info(`Redis ${role} connection ${connectedBefore ? "restored" : "ready"}.`);
        connectedBefore = true;
        reportedLoss = false;
      });
    }

    const initialize = async () => {
      await new Promise((resolve) => {
        onReady = () => {
          if (clients.every((client) => client.status === "ready")) resolve();
        };
        for (const client of clients) {
          client.on("ready", onReady);
          // ioredis retries after the initial connect promise rejects.
          client.connect().catch(() => {});
        }
      });

      collectSubscriptions = true;
      io.adapter(createAdapter(publisher, subscriber, { key: keyPrefix }));
      collectSubscriptions = false;
      // Check subscription permissions and acknowledgements before listening.
      await Promise.all(subscriptions);
    };
    await Promise.race([
      initialize(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error()), CONNECT_TIMEOUT_MS);
      }),
    ]);

    io.httpServer.once("close", disconnect);
    logger.info("Socket.IO Redis Pub/Sub adapter enabled.");
  } catch {
    disconnect();
    throw new Error("Unable to initialize Socket.IO Redis Pub/Sub within 10 seconds. Check REDIS_URL, credentials, TLS, and network access.");
  } finally {
    clearTimeout(timeout);
    for (const client of clients) {
      if (onReady) client.off("ready", onReady);
    }
  }
}
