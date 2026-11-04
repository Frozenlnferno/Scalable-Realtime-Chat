# Distinct-user realtime benchmarks

The default `realtime` workload gives every selected account exactly one persistent Socket.IO connection, with disjoint pairs sending in both directions. Provisioning and AWS load generation happen only through explicit commands. There are no backend or deployment changes.

## Setup (Bash)

Use **Node 22.22 or newer** for per-worker CPU accounting.

```bash
cd /c/Users/jstno/Scalable-Realtime-Chat/load-tests
# WSL: /mnt/c/Users/jstno/Scalable-Realtime-Chat/load-tests
node --version
npm ci
test -f .env.local || cp .env.example .env.local
```

Configure `.env.local` with the existing deployment:

```dotenv
CHAT_API_URL=https://YOUR_BACKEND_ORIGIN
CHAT_COGNITO_USER_POOL_ID=us-east-1_YOUR_POOL
CHAT_COGNITO_CLIENT_ID=YOUR_EXISTING_APP_CLIENT
# Optional CHAT_SOCKET_URL and CHAT_SOCKET_PATH (default /socket.io)
```

Use an HTTP(S) origin without `/api`, credentials or queries. The frontend aliases `VITE_COGNITO_USER_POOL_ID` and `VITE_COGNITO_USER_POOL_CLIENT_ID` are accepted. The repository root environment is not loaded automatically. CloudFront/ALB must forward Authorization, disable authenticated API caching, allow POST and support WebSocket upgrades.

## Provision the reusable account pool

Configure standard AWS credentials (environment, shared profile, SSO or role) permitting Cognito `AdminCreateUser` and `AdminSetUserPassword`. Region follows the pool ID. Use a mailbox supporting plus aliases and a test pool/app client permitting administrative creation and SRP sign-in.

```bash
npm run bench:users -- --count 2500 \
  --email-base you@example.com --out users.bench.local.json
```

This command suppresses invitations, marks each test email verified and sets a random permanent password, without changing pool-wide verification. It uses four concurrent operations with throttling backoff. Generated credentials and resumable progress are saved atomically in ignored local files before remote mutations. Keep the progress journal with the credential file. Rerun the same command to resume or increase the pool; lowering the count never removes credentials/accounts. Existing unrelated credential files are rejected and preserved.

If provisioning reports missing AWS credentials, signing in to the AWS browser console is not enough: configure credentials for the terminal with `aws configure`, or use `aws configure sso` and `aws sso login --profile YOUR_PROFILE` with `AWS_PROFILE` set to that profile. Provisioning reports safe operation-specific errors without printing raw AWS responses or secrets. Keep the existing journal and rerun the original command after fixing credentials/permissions.

A process lock prevents concurrent provisioning; valid abandoned locks recover after the owner exits. Inspect a malformed lock before removing it. Passwords and tokens are never printed. Protect local files containing reusable credentials. Alternatively supply an existing JSON array of distinct `{ "username": "...", "password": "..." }` accounts; ordinary runs never provision users.

## Validate, then choose load manually

```bash
npm run bench -- realtime --profile small --clients 4 \
  --accounts users.bench.local.json --tasks 1 --seed 42

npm run bench -- realtime --profile load --clients 500 \
  --accounts users.bench.local.json --tasks 1 --seed 42
```

`small` defaults to four clients, with a two-second ramp and ten-second measurement. `load` requires an explicit even `--clients` count, at least two and bounded by the supplied pool. It ramps over **120 seconds** and measures for **300 seconds**. A 2,500-account pool does not automatically start 2,500 clients. Rough offered rates are 125 messages/sec for 500 clients and 250 for 1,000; reports show actual scheduled/measured rates.

Selection uses a seeded shuffle of the canonical account list and disjoint pairs. Only selected accounts sign in, through four concurrent isolated SRP processes. Additional challenges fail setup. Each pair prepares one conversation and reads its history before measurement. Tokens are rechecked after preparation and must remain valid through the bounded run plus safety margin.

The default `--workers 4` is capped by complete pairs; each pair stays on one thread. Requested and actual worker counts are recorded. Artillery runs one controller virtual user to coordinate these workers and relay custom metrics. **That controller is not the client count.** Use actual clients, distinct identities and socket timelines from the benchmark report.

Listeners attach before connection. Handshakes have bounded concurrency and ten-second deadlines. No messages are sent during ramp. Measurement begins after the ramp and after every client connects, with fifteen seconds of readiness grace; otherwise setup fails without messaging.

Both paired clients send with staggered initial slots and independently seeded 3–5-second intervals. Monotonic deadlines are independent of response completion. Up to four sends may remain pending per client. Slots over 100 ms late are skipped and recorded; limit hits and missed slots never cause silent traffic reduction or catch-up bursts. Automatic retries, reconnection and replacement clients are disabled. Individual message failures do not stop independent outcomes or shorten the measurement window. Unexpected disconnects fail the run.

POST and delivery deadlines are ten seconds. Scheduling stops at the measurement boundary, outstanding work drains for at most ten seconds, and sockets, listeners, timers and temporary token files are released. Abrupt OS/process termination can leave its `chat-pool-*` temporary directory behind.

## Hold deployment capacity fixed

`--tasks` is **metadata only**. Manually set ECS desired capacity to one or three, verify all targets healthy and keep capacity/autoscaling fixed throughout each run. The runner cannot verify ECS counts. Record deployment revision, runner location/resources, task CPU/memory and initial database size.

Monitor ECS CPU/memory, restarts/service events; ALB target health, latency and errors; RDS CPU, connections, free memory, read/write latency and storage I/O; and Redis CPU/memory/connections. Record timestamps and infrastructure changes alongside results. Check generator health before attributing failures to backend capacity.

## Reports and acceptance

Each run creates `results/realtime-pool-TASKStask-TIMESTAMP-ID/` containing:

- `artillery.json`: original aggregate/interval metrics, including `pool.*` custom metrics.
- `metadata.json`: workload version, account/pair/schedule fingerprints, clients, seed, actual/requested workers, timing, thresholds, source revision/fingerprint, runner configuration, declared tasks and start time.
- `summary.json` and `summary.md`: outcomes, rates, distributions, connection timeline, generator health and end time.
- `traces/pool-*.jsonl`: buffered non-secret message outcomes and lifecycle records. Aggregation streams these files using bounded histograms; percentiles are rounded up to 1 ms, conservatively at acceptance limits.

Correlation checks unique message body, conversation, sender, designated receiving socket and returned message ID, including delivery before HTTP completion. Observations without known HTTP success remain **ambiguous submissions**. Traces retain their observed latencies. Missing recipient events, missing echoes and duplicate matching events are counted independently. Recipient confirmations and sender echoes do not represent two unique messages.

Reports separate scheduled sends/sec, attempted sends/sec, successful writes/sec and unique recipient confirmations/sec. Planned, attempted, posted, confirmed, ambiguous and unattempted counts are shown, with unconfirmed-posted percentage separate from scheduled-workload completion. POST latency includes JSON parsing. Recipient/echo latency starts at POST initiation and ends in the designated Socket.IO handler. Missing outcomes do not become latency samples; inspect success counts alongside percentiles.

Whole-window and final-four-minute latency cohorts use **scheduled time**, including outcomes during the final drain. Receipt-time throughput counts arrivals inside each explicit window and excludes drain. The short profile uses its full ten seconds for both windows. Health includes worker thread CPU, event-loop delay, dispatch lag, missed slots and in-flight limit hits.

Default acceptance requires every selected identity to stay connected, every scheduled message to be attempted, successfully posted and confirmed by both sockets, zero unexpected disconnects/duplicates, API p95 below **500 ms** and recipient p95 below **200 ms**, for both whole and settled windows. Any missed slot, in-flight limit hit or worker dispatch-lag p95 above **50 ms** makes the run ineligible for capacity claims. Failed setup, Artillery or acceptance produces an unsuccessful runner exit.

## Repetitions and comparisons

```bash
for repetition in 1 2 3; do
  npm run bench -- realtime --profile load --clients 500 \
    --accounts users.bench.local.json --tasks 1 --workers 4 --seed 42 || break
done
# Manually set/verify three healthy ECS tasks; repeat with --tasks 3.

npm run bench:compare -- --mode fixed results/RUN_A results/RUN_B
npm run bench:compare -- --mode capacity results/RUN_1 results/RUN_2
```

Supply all repetition directories to establish sustainability. Two input runs provide preliminary results only. Fixed mode requires matching client counts, selections/pairs/schedules, thresholds, timing, source and runner configuration. Capacity mode permits different client counts/selections/schedules, holding per-client behavior and other comparison settings fixed. Use the same requested/actual workers, seed, account pool, target and source. Reusing a run ID does not count as a repetition.

Three passing repetitions with no failing supplied repetition at a candidate level are required to call it consistently sustainable. Comparison reports identify the **highest tested sustainable throughput**, any higher failing level, and scaling ratios from measured recipient-confirmed throughput. Test higher levels manually as needed. Reaching the pool ceiling does not establish the backend's absolute maximum.

## Persistence and Redis evidence

`realtime` is the only benchmark workload. `pool.yml` starts one Artillery controller, which coordinates the connection ramp and measurement in worker threads. The previous `chat` command, `--workload sessions` option and their YAML scenarios have been removed. Historical reports remain in the ignored `legacy-archive/` directory; older workload versions are rejected by the comparison tool.

Source changes invalidate strict comparisons with earlier runs. Start a fresh set of repetitions after updating the runner, even when the workload version is unchanged.

Runs leave persistent database messages and conversation history. Automatic database cleanup is excluded. These benchmarks cannot identify which ECS task handled a socket or request, and do not prove cross-instance Redis forwarding. Keep the existing Redis integration test as separate evidence:

```bash
cd ../server
REDIS_TEST_URL='redis://YOUR_REACHABLE_TEST_REDIS:6379' npm test
```

## Local verification

```bash
cd load-tests  # from repository root
npm test
```

Tests generate no AWS traffic. They cover provisioning resume/backoff, isolated SRP and expiry, deterministic selection/pairs/schedules, controllable-clock readiness/duration/overlap/timeouts/drain/cleanup, early/unrelated/missing/ambiguous/duplicate events, disconnects, generator overload, streamed cohorts, comparison compatibility and multi-worker aggregation. Real Artillery CLI scenarios run against local HTTP/Socket.IO fixtures, verify reports and check successful/unsuccessful runner results. Fixture reports use the OS temporary directory.
