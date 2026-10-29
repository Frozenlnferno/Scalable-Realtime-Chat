# Scalable Realtime Chat

A minimum direct-message application using AWS Cognito for identity and local PostgreSQL as the development replacement for Amazon RDS.

## Run locally

1. Copy `.env.example` to `.env`, then fill in the Cognito user-pool values. The project’s existing `.env` can be retained if it already contains them.
2. Start Docker Desktop.
3. Run `docker compose up --build`.
4. Open `http://localhost:5173` and create/confirm an account through Cognito. Sign in with a second confirmed account in another browser session to test a direct conversation.

The server runs migrations automatically on startup. PostgreSQL data is retained in the `postgres_data` Docker volume. Use `docker compose down -v` only when you intentionally want to erase local chat data.

## Architecture

- Cognito remains the authentication provider. The browser sends an ID token and the API validates its signature, audience, issuer, expiration, and token use.
- The first authenticated request or socket connection syncs a local `users` profile. The directory therefore includes users after their first sign-in.
- Local PostgreSQL represents RDS. The backend is organized by `users`, `conversations`, and `messages` features, with shared database, authentication, and Socket.IO infrastructure under `server/src/core`.
- Messages are persisted through the REST API and emitted to authenticated Socket.IO rooms for exactly the sender and recipient. One reusable direct conversation exists for each pair of users.

## Socket.IO communication through ElastiCache

Set these server-only values in the root `.env` for Docker Compose, or in the backend environment when running it directly:

```dotenv
REDIS_URL=rediss://username:password@your-primary-endpoint:6379
REDIS_KEY_PREFIX=chat:socket.io
```

Use the **primary endpoint of a provisioned ElastiCache Redis OSS cache with cluster mode disabled**. Use `rediss://` when in-transit encryption is enabled; TLS certificates are verified. URL-encode special characters in the username/password. Omit the username or credentials if your cache's authentication configuration does not require them. Keep the URL in the ignored `.env` file or server environment; never use a `VITE_` variable for it. No AWS SDK or AWS access keys are required by this integration.

Every communicating backend instance must connect to the same cache with the same `REDIS_KEY_PREFIX`. Choose a different prefix for each independent environment. Each instance opens separate publisher and subscriber connections, and the adapter forwards existing user-room broadcasts across instances. PostgreSQL continues to store messages; Redis Pub/Sub does not provide durable event replay.

Local Docker must have network access to the ElastiCache endpoint and port, including the cache's security-group rules and any required private network routing. Supplying a private endpoint alone does not establish that access. You supply the cache, credentials, and connectivity; this repository does not provision AWS resources or change networking.

When `REDIS_URL` is empty, the backend uses the original in-memory adapter and local chat works as before. When it is configured, startup waits for both Redis connections and confirmed subscriptions, with a 10-second deadline. Connection, credential, TLS, or subscription failures stop startup instead of silently starting without cross-instance delivery. Connection logs exclude URLs, credentials, and raw Redis errors.

After startup, interrupted Redis connections reconnect and restore subscriptions automatically. Connection loss and recovery are logged. During an interruption, broadcasts still reach clients on the emitting instance; cross-instance delivery is unavailable. Events missed during an interruption are not replayed by this adapter. The existing message history API remains available for persisted messages.

### Adapter checks

Run `npm test` from `server/`. This checks local delivery and isolation, malformed configuration, and the 10-second connection failure/cleanup path. Tests use isolated Socket.IO servers without Cognito or PostgreSQL; they do not exercise a full signed-in browser conversation.

To enable the two-server Redis integration test, provide a reachable Redis endpoint using `REDIS_TEST_URL`:

```powershell
$env:REDIS_TEST_URL = 'rediss://username:password@your-primary-endpoint:6379'
npm test
```

The test uses a unique channel prefix, verifies delivery in both directions, checks recipient isolation and duplicates, and closes both Redis connections on shutdown. Without `REDIS_TEST_URL`, it is explicitly skipped. Tests read this variable from the process environment, not `.env`.

## API

All endpoints require `Authorization: Bearer <Cognito ID token>`.

- `GET /api/users` — synced users other than the caller.
- `POST /api/conversations/direct` — opens a direct conversation with `{ "recipientUserId": "..." }`.
- `GET /api/conversations/:conversationId/messages` — latest 50 messages, with an optional `cursor` query parameter.
- `POST /api/conversations/:conversationId/messages` — persists `{ "body": "..." }` and emits `message:created`.
