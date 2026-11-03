# Scalable Realtime Chat

A minimum direct-message application using AWS Cognito for identity and local PostgreSQL as the development replacement for Amazon RDS.

## Run locally

1. Copy `.env.example` to `.env`, then fill in the Cognito user-pool values. The project’s existing `.env` can be retained if it already contains them.
2. Start Docker Desktop.
3. Apply database migrations once with `docker compose run --rm server npm run migrate`.
4. Run `docker compose up --build`.
5. Open `http://localhost:5173` and create/confirm an account through Cognito. Open `http://localhost:5174` and sign in with a second confirmed account to test a direct conversation across the two backend instances.

Migrations run only when you invoke the migration command. PostgreSQL data is retained in the `postgres_data` Docker volume. Use `docker compose down -v` only when you intentionally want to erase local chat data.

### Two local backend instances

After you apply migrations, `docker compose up --build` starts `server` at `http://localhost:3000` and `server2` at `http://localhost:3001`. Both listen on port 3000 inside their own containers and share PostgreSQL and Redis. The second backend waits for the first backend to become healthy before starting.

When the root `.env` has an empty or unset `REDIS_URL`, Compose connects both backends to its local `redis` service at `redis://redis:6379`. Redis is available on the Compose network; it does not publish a host port. Set `REDIS_URL` to a reachable ElastiCache endpoint to use AWS instead.

Compose also starts two frontends, each connected directly to a different backend:

| Service | Browser URL | Default API and Socket.IO endpoint |
| --- | --- | --- |
| `client` | `http://localhost:5173` | `http://localhost:3000` |
| `client2` | `http://localhost:5174` | `http://localhost:3001` |

The first frontend uses `VITE_API_URL` and `VITE_SOCKET_URL` from the root `.env`, defaulting to port 3000. The second frontend is built for port 3001, and `server2` allows requests from `http://localhost:5174`. Run `docker compose up --build` after changing frontend settings because these endpoints are embedded during the image build.

Sign in as a different user in each frontend, open their direct conversation, and send messages in both directions. Messages should appear live in the other frontend without refreshing; this exercises Redis delivery between the two backend instances. Both frontends share message history through PostgreSQL. No load balancer is required for this setup.

## Architecture

- Cognito remains the authentication provider. The browser sends an ID token and the API validates its signature, audience, issuer, expiration, and token use.
- The first authenticated request or socket connection syncs a local `users` profile. The directory therefore includes users after their first sign-in.
- Local PostgreSQL represents RDS. The backend is organized by `users`, `conversations`, and `messages` features, with shared database, authentication, and Socket.IO infrastructure under `server/src/core`.
- Messages are persisted through the REST API and emitted to authenticated Socket.IO rooms for exactly the sender and recipient. One reusable direct conversation exists for each pair of users.

## PostgreSQL connections to RDS

The backend Docker image includes the public AWS RDS CA bundle at `/app/certs/rds-global-bundle.pem`. For an RDS deployment, store this server-only connection string in Secrets Manager and inject it as `DATABASE_URL`:

```text
postgresql://chat_app:URL_ENCODED_PASSWORD@RDS_ENDPOINT:5432/chat?sslmode=verify-full&sslrootcert=/app/certs/rds-global-bundle.pem
```

Use the actual RDS endpoint so hostname verification succeeds. These parameters enable TLS and verify the server certificate; they apply to both the backend and `npm run migrate`. The certificate path is inside the container. For a backend running directly on the host, download the AWS RDS CA bundle and use its local path instead.

The image build downloads the public bundle from AWS and requires network access to `truststore.pki.rds.amazonaws.com`. No database credentials are needed during the build. Local Compose retains its existing PostgreSQL URL without these TLS parameters. Creating RDS does not apply the application migrations; run them explicitly from a container with VPC access before starting the service.

## Socket.IO communication through ElastiCache

Set these server-only values in the root `.env` for Docker Compose, or in the backend environment when running it directly:

```dotenv
REDIS_URL=rediss://username:password@your-primary-endpoint:6379
REDIS_KEY_PREFIX=chat:socket.io
```

Use the **primary endpoint of a provisioned ElastiCache Redis OSS cache with cluster mode disabled**. Use `rediss://` when in-transit encryption is enabled; TLS certificates are verified. URL-encode special characters in the username/password. Omit the username or credentials if your cache's authentication configuration does not require them. Keep the URL in the ignored `.env` file or server environment; never use a `VITE_` variable for it. No AWS SDK or AWS access keys are required by this integration.

Every communicating backend instance must connect to the same cache with the same `REDIS_KEY_PREFIX`. Choose a different prefix for each independent environment. Each instance opens separate publisher and subscriber connections, and the adapter forwards existing user-room broadcasts across instances. PostgreSQL continues to store messages; Redis Pub/Sub does not provide durable event replay.

Local Docker must have network access to the ElastiCache endpoint and port, including the cache's security-group rules and any required private network routing. Supplying a private endpoint alone does not establish that access. You supply the cache, credentials, and connectivity; this repository does not provision AWS resources or change networking.

When a backend is started directly with an empty `REDIS_URL`, it uses the original in-memory adapter. Compose supplies its local Redis URL by default. When a Redis URL is configured, startup waits for both Redis connections and confirmed subscriptions, with a 10-second deadline. Connection, credential, TLS, or subscription failures stop startup instead of silently starting without cross-instance delivery. Connection logs exclude URLs, credentials, and raw Redis errors.

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

For Artillery setup, AWS/CloudFront testing, saved reports, and performance measurement, see [the load-testing guide](load-tests/README.md).

All endpoints require `Authorization: Bearer <Cognito ID token>`.

- `GET /api/users` — synced users other than the caller.
- `POST /api/conversations/direct` — opens a direct conversation with `{ "recipientUserId": "..." }`.
- `GET /api/conversations/:conversationId/messages` — latest 50 messages, with an optional `cursor` query parameter.
- `POST /api/conversations/:conversationId/messages` — persists `{ "body": "..." }` and emits `message:created`.
