# API and real-time benchmarks

These tests exercise the existing AWS deployment without backend changes. `chat.yml` measures authenticated REST requests. `realtime.yml` sends through REST and verifies delivery to two connected Socket.IO clients. They do not render the React frontend.

## Setup (Bash)

Use Node **22.18 or newer** in the same shell that runs npm. From Git Bash:

```bash
cd /c/Users/jstno/Scalable-Realtime-Chat/load-tests
# WSL: cd /mnt/c/Users/jstno/Scalable-Realtime-Chat/load-tests
node --version
npm install
test -f .env.local || cp .env.example .env.local
cp users.example.json users.local.json
```

Only copy the accounts example the first time; do not overwrite an existing account file. Subsequent dependency installs can use `npm ci` with the committed lockfile.

Edit `.env.local` and set:

```dotenv
CHAT_API_URL=https://dssej3gu564di.cloudfront.net
CHAT_COGNITO_USER_POOL_ID=YOUR_EXISTING_USER_POOL_ID
CHAT_COGNITO_CLIENT_ID=YOUR_EXISTING_APP_CLIENT_ID
# Optional, if sockets use a separate origin/path:
# CHAT_SOCKET_URL=https://dssej3gu564di.cloudfront.net
# CHAT_SOCKET_PATH=/socket.io
```

Use an origin without `/api/`; scripts supply the API paths. The Cognito identifiers are the existing frontend values `VITE_COGNITO_USER_POOL_ID` and `VITE_COGNITO_USER_POOL_CLIENT_ID`. These aliases are also accepted in this file. No app-client secret or AWS access keys are needed. The region follows the user-pool ID. The runner reads this local file; it does not automatically import the repository root's environment.

In `users.local.json`, supply at least four **different confirmed test accounts** with permanent passwords:

```json
[
  { "username": "test1@example.com", "password": "YOUR_PASSWORD" },
  { "username": "test2@example.com", "password": "YOUR_PASSWORD" },
  { "username": "test3@example.com", "password": "YOUR_PASSWORD" },
  { "username": "test4@example.com", "password": "YOUR_PASSWORD" }
]
```

This file and `.env.local` are ignored by Git. Keep credentials in these files, not shell arguments. The runner does not create accounts, change Cognito settings, or bypass MFA; it stops if an account needs an additional authentication challenge. Larger pools are supported. Every unordered pair is prepared, so setup performs N(N-1)/2 conversation requests.

Before measurement, the runner signs in once per account using Amplify SRP in isolated processes, validates every ID token through `/api/users`, discovers application UUIDs, and prepares conversations. Tokens must remain valid for the complete profile's maximum duration plus 60 seconds. Setup is excluded from the benchmark. Each run signs in afresh; a mid-run refresh is not needed for these bounded profiles. Temporary authentication data is removed when the runner exits normally or handles an interruption; abrupt OS/process termination may leave its `chat-bench-*` temporary directory behind. Reports never intentionally contain tokens, passwords, or account email addresses.

## Run the small profiles first

From `load-tests/`:

```bash
npm run bench -- chat --tasks 1 --seed 42
npm run bench -- realtime --tasks 1 --seed 42
```

The default `small` profile starts four sessions over four seconds. Each sends five messages: 20 writes and 32 scenario API requests. The API test normally finishes in under a minute; the real-time test normally takes just over a minute because sockets stay connected for at least 60 seconds.

The runner performs an authenticated preflight automatically before starting either scenario.

Use the benchmark runner for the revised chat/realtime YAML files; it supplies authentication state and case data. Running them directly without the runner is unsupported.

## Run the load profile

```bash
npm run bench -- chat --profile load --tasks 1 --seed 42
npm run bench -- realtime --profile load --tasks 1 --seed 42
```

`--tasks` is a **label**, not an AWS command. Set ECS desired capacity separately, keep it fixed, and confirm every target is healthy before testing. The runner cannot verify the task count or change autoscaling. Each command executes one run.

| Phase | Time | Sessions started |
| --- | ---: | ---: |
| Warm-up | 60 seconds | 6 total |
| Build | 120 seconds | 60 total |
| Steady | 300 seconds | 1 each second |

Total: **366 sessions, 1,830 message writes, and 2,928 scenario API requests**. The real-time run normally takes about nine minutes including its final sessions finishing; the overall session deadline can extend it to ten minutes, excluding setup and CLI startup. The steady phase offers approximately five message writes/second, with roughly 60 overlapping real-time sessions and 120 sockets. These are estimates; use the report's measured concurrency and completion rates.

All runs write real database messages prefixed `[artillery ...]`. They reuse conversations and leave history intact. There is no automatic data deletion. Run against your test deployment and test accounts.

## What each session does

`chat.yml` uses Artillery's HTTP engine. A session selects a sender and a different account, fetches the directory, opens their conversation, reads history, then sends five messages with random pauses of 2–8 seconds before each send. It finishes immediately after messaging; an idle REST session is not a live socket connection.

`realtime.yml` connects both participants, performs the same eight REST requests, confirms each message on both designated sockets, and keeps the connections open for at least 60 seconds from when both connected. HTTP setup time is included in this connection lifetime. Event listeners are registered before POST: socket delivery may precede the HTTP response. Unrelated broadcasts are ignored. Matching conversation, sender, body, and returned message ID prevents them from satisfying the test. Duplicate matching events remain monitored during the idle period.

The recipient's confirmation and the sender's echo are separate metrics: **five writes do not mean ten unique messages**. The sender and recipient sockets belong to different accounts, but other sessions can reuse either account. Four users have three possible partners apiece, giving six distinct direct conversations. Additional connections sharing an account also receive that account's broadcasts; this is a shared-account/fanout workload, not hundreds of independent users. Increase the account pool before making distinct-user capacity claims.

Both scripts use the same seeded case generation. Keep the seed, account ordering, runner CPU/worker configuration, profile, and code revision the same for a task-count comparison. A workload fingerprint records the case selections actually used; differing fingerprints indicate a different case assignment. Session/message correlation IDs remain unique across runs.

Socket transports are WebSocket-only, with reconnection disabled. Test the frontend's polling/upgrade path separately if needed. Requests, connection setup, and delivery waits have ten-second timeouts; sessions have a 120-second deadline. Unexpected disconnects during sending **or idle time** fail the session. Message retries are disabled. A failed POST is not proof that no database write occurred.

## Read the reports

Each run prints the path to a new directory under `results/`:

```text
results/realtime-3task-TIMESTAMP-ID/
  artillery.json     Original aggregate and interval metrics
  metadata.json      Profile, seed, task label, code revision, timing settings
  summary.md         Readable results and pass/fail checks
  summary.json       Detailed measurements and concurrency timeline
  traces/           Per-worker non-secret timing/lifecycle records
```

**Start with `summary.md` and its checks**, then inspect endpoint distributions and concurrency in `summary.json`. The raw Artillery report retains the familiar `aggregate` and `intermediate` sections.

| Metric | Meaning |
| --- | --- |
| API p50 / p95 / p99 | Median / 95th / 99th percentile latency, in milliseconds |
| Endpoint timings | Directory, conversation open, history, message write |
| `chat.delivery_ms` | POST start to matching receipt by the designated recipient |
| `chat.echo_ms` | POST start to matching sender echo |
| `chat.connect_ms` | One authenticated Socket.IO connection |
| `chat.messages_planned` | Five messages for every session that starts |
| `chat.messages_attempted` / `chat.messages_sent` | POST attempts / successful validated POST responses |
| `chat.messages_received` / `chat.sender_echoes` | Confirmed unique deliveries for the designated sockets |
| Active sessions / sockets | Merged lifecycle events from every worker; not a sum of worker peaks |
| Successful requests or writes/sec | Successful completions divided by the explicit measured window duration |

For `chat.yml`, HTTP metrics are Artillery's **time to first byte**. The real-time processor uses native fetch and records custom `chat.http_ms.*` timings **through complete JSON parsing**, not built-in `http.*` timings. Recipient/echo timing includes network, persistence, and broadcast but not browser rendering. Clock synchronization with the server is unnecessary: durations use a monotonic clock on the runner.

Summary percentiles use exact nearest-rank calculations from the trace samples. Artillery uses histograms, so its displayed percentiles can differ slightly. Failed HTTP responses in the API scenario can have timings; native-fetch failures and missing deliveries do not become successful latency samples. Always inspect success counts before interpreting latency.

The summary contains whole-run, steady-phase, and settled-phase results. The settled window excludes the first minute of steady load, leaving its final four minutes. Window rates count events completed within wall-clock windows, not cohorts of sessions that started together. A delivery can arrive before its HTTP response, so interval confirmation and successful-post counts need not match exactly even when full-run counts do.

Lifecycle traces use millisecond timestamps. Ordering between workers at the same millisecond is approximate. Missing/unbalanced lifecycle events fail the run rather than silently producing an authoritative concurrency claim. Normal closure after the idle hold is not counted as an unexpected disconnect.

### Pass criteria

- API p95 below **500 ms**.
- Recipient delivery p95 below **200 ms** for real-time runs.
- Every scheduled session starts and completes.
- All planned requests succeed and all planned messages are posted.
- Real-time messages are confirmed by both designated sockets.
- Zero duplicate matching events or unexpected disconnects; lifecycle traces close cleanly.

The runner exits nonzero when checks fail, including when Artillery exits nonzero or leaves incomplete output. It does not silently treat a partial or interrupted run as a successful benchmark. Latency criteria are project targets, not universal standards. Each window's metrics are shown separately; whole-run acceptance does not imply every reporting interval meets a target.

## Compare one and three tasks

Use the same runner, seed, account file/order, deployment revision, task CPU/memory, and workload. Keep task count fixed throughout each run and record any autoscaling activity. Note runner location and initial database size: these runs add history, and reused accounts/conversations can cause row contention.

Run three repetitions at one task:

```bash
for i in 1 2 3; do
  npm run bench -- realtime --profile load --tasks 1 --seed 42 || break
done
```

After separately setting three healthy ECS tasks, repeat with `--tasks 3`. Repeat the API scenario in the same way. A loop stops on a failed run so you can investigate before creating more load. Timestamped directories retain every attempt.

During each run, record ECS CPU/memory/task restarts, RDS CPU/connections/read-write latency, and ALB errors if applicable. Compare delivery and API p95/p99, successful throughput, failures, and measured concurrency. A lower latency from one comparison is preliminary evidence; repeatability and resource trends make the explanation stronger. These new five-message, minute-long sessions are **not equivalent** to the earlier short three-message benchmarks.

A useful resume claim states observed concurrent connections, messages/sec, latency, duration, and failures. Do not describe total sessions as concurrent users or offered throughput as maximum capacity.

## AWS routing and Redis evidence

The existing CloudFront deployment must forward authenticated `/api/*` traffic and `/socket.io/*` traffic to the backend. Authenticated API caching must be disabled and Authorization forwarded. POST must be allowed; WebSocket handshake headers must reach the origin. HTML fallback responses are rejected by response validation. Configuration is not changed by the runner.

These tests verify delivery **through** your deployment. They cannot identify which ECS task handled a request or connection, and therefore cannot prove that a particular delivery crossed Redis. Use the existing two-server Redis integration test as separate evidence:

```bash
cd ../server
REDIS_TEST_URL='redis://YOUR_REACHABLE_TEST_REDIS:6379' npm test
```

Keep Redis private; run that integration test from a network that can reach the test cache. It uses isolated test servers and a unique channel prefix. No backend instrumentation or deployment is required for the revised benchmarks.

## Local verification

```bash
cd load-tests  # from repository root
npm test
```

Tests cover authentication setup, deterministic workloads, response validation, delivery-before-HTTP races, missing/duplicate events, idle disconnects, deadlines, minute-long holds using a controllable clock, and merged concurrency. Local fixture tests execute the actual Artillery CLI and both YAML scenarios with shorter test-only timings, checking successful and unsuccessful exits. They never sign in to AWS or write to the AWS deployment. Temporary fixture results are stored in the OS temporary directory.
