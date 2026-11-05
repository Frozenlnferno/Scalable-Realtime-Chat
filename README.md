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

## Database contention and overload handling

Conversation and message HTTP routes authenticate once. Every request and socket connection still verifies its Cognito token; existing users with unchanged emails are resolved with an indexed read instead of a profile rewrite. New users and email changes use the conflict-safe upsert. Message insertion and conversation timestamp updates commit together in one SQL statement; socket events are emitted after that statement succeeds. An existing-user message normally performs three database calls: `users.resolve`, `conversations.participant`, and `messages.insert_and_touch`.

Application database sessions use these server environment settings (also forwarded by Compose):

| Variable | Default | Meaning |
| --- | ---: | --- |
| `DB_POOL_MAX` | 10 | Maximum connections per backend process |
| `DB_POOL_MAX_WAITING` | 100 | Maximum queued acquisitions when the pool is saturated; zero rejects immediately |
| `DB_POOL_ACQUIRE_TIMEOUT_MS` | 2000 | Maximum connection acquisition time |
| `DB_STATEMENT_TIMEOUT_MS` | 5000 | PostgreSQL statement execution timeout |
| `DB_LOCK_TIMEOUT_MS` | 1000 | PostgreSQL lock acquisition timeout |

Values must be non-negative integers for the queue limit and positive integers otherwise. Lock timeout must be shorter than statement timeout; invalid settings fail startup. Limits apply regardless of diagnostic logging. Migration sessions do not inherit these application timeouts. The backend returns HTTP **503** with a generic message for pool overload, acquisition timeout, and recognized database timeout/unavailability errors. Invalid Cognito credentials remain HTTP **401**; database failures during user resolution are not classified as invalid credentials. Expected 503s are covered by the bounded timing logs, not logged individually.

There are no automatic message retries. A lost response can leave the result unknown even if the write committed. These limits bound individual database operations, not total request time. Keep the pool at 10 for the first retest. Any later increase must account for all backend processes, replacement tasks during deployment, other database clients, and the RDS connection budget.

Backend regression checks run with `npm test` from `server/`. To include PostgreSQL integration checks, set `TEST_DATABASE_URL` to a dedicated local test database before running them. The tests create and remove their own randomly named schema and verify concurrent user synchronization, atomic writes/rollback, the three-query HTTP path, and real pool/statement/lock timeouts. They never use the deployment's `DATABASE_URL` as a fallback. The Redis integration check still requires `REDIS_TEST_URL` separately.

For rollout, publish a uniquely tagged backend image, create a task-definition revision with the settings above, and wait until all three replacement tasks are healthy at the existing 1 vCPU / 2 GiB. Enable the timing diagnostics below. From the same EC2 generator and benchmark version, run the small profile, then 1,000 and 2,000 clients separately with `--tasks 3 --seed 42`. Preserve reports and deployment revision. Compare completion and confirmed throughput alongside API/delivery p95 and p99, queue sizes, and timeout counts; quick 503 responses are not a capacity improvement. Roll back the service to its previous task-definition revision if ordinary traffic regresses. No schema migration is required for these changes.

## Backend timing diagnostics

For load-test investigations, set these environment variables on the backend ECS task definition, deploy the updated backend image, and wait for all replacement tasks to become healthy:

```dotenv
REQUEST_TIMING_ENABLED=true
REQUEST_TIMING_SLOW_MS=500
```

Slow requests (500 ms or longer), HTTP 5xx responses, and prematurely closed responses emit a JSON `request_timing` log to stdout. With the ECS `awslogs` driver, find these entries in the backend's CloudWatch log group. Output is capped at one entry per second per backend process; `suppressedSinceLastLog` counts eligible entries omitted since the previous log. These are diagnostic samples, not latency percentiles or a complete error count. Logs include instance hostname, request duration, static route template, status, connection-pool counts, and database operation totals. They exclude tokens, user identifiers, message bodies, SQL, query parameters, and raw errors.

- `dbWaitMs`: total time acquiring database connections, including queueing and connection establishment.
- `dbQueryMs`: total time awaiting queries after acquiring a connection, including database/network waits. This is not database CPU time.
- `dbOperations`: calls, failures, connection wait and query time by static operation name, such as `users.resolve` or `messages.insert_and_touch`.
- `dbPending`: database operations still outstanding when the response closes. Global wait/query totals include elapsed time for those operations; per-operation totals reflect completed phases.
- `dbOutstanding`: operation names, current phase (`wait` or `query`), and elapsed phase time for unfinished operations.
- `dbErrors`: sanitized counts (`db_overloaded`, `db_acquire_timeout`, `db_statement_timeout`, `db_lock_timeout`, `db_unavailable`, or `db_error`).
- `pool.max`, `pool.waiting`, `pool.total`, `pool.idle`: this process's configured maximum and current connection-pool state.
- `status`: `null` for aborted responses whose headers were never sent; the default HTTP status is not evidence of success.

High `dbWaitMs` with a nonzero pool queue suggests connection contention; high `dbQueryMs` points toward database queries/network/lock/storage waits. Long request duration with low database totals points elsewhere in the application. For parallel queries, summed database time can exceed wall-clock request time. Timing starts when Express receives the request and does not measure CloudFront or ALB queueing. Set `REQUEST_TIMING_ENABLED=false` and redeploy after the investigation. Diagnostics preserve query behavior and pool size; they do not resolve the underlying bottleneck.

CloudWatch Logs Insights (select all backend task streams and the benchmark's time window):

```sql
fields @timestamp, instance, route, durationMs, dbWaitMs, dbQueryMs, dbCalls, dbPending, pool.waiting, dbOperations
| filter event = "request_timing"
| sort @timestamp asc
| limit 200
```

## API

For Artillery setup, AWS/CloudFront testing, saved reports, and performance measurement, see [the load-testing guide](load-tests/README.md).

All endpoints require `Authorization: Bearer <Cognito ID token>`.

- `GET /api/users` — synced users other than the caller.
- `POST /api/conversations/direct` — opens a direct conversation with `{ "recipientUserId": "..." }`.
- `GET /api/conversations/:conversationId/messages` — latest 50 messages, with an optional `cursor` query parameter.
- `POST /api/conversations/:conversationId/messages` — persists `{ "body": "..." }` and emits `message:created`.
