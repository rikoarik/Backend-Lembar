# B0-06 — Queue + idempotency spike

Status: READY_FOR_OWNER_REVIEW (B0-06 spike)

## Scope delivered

- Queue decision candidate for D-004: **custom Postgres-only queue** for this modular monolith.
- Local proof facade `src/infrastructure/queue/application/QueueSpike.ts` with acceptance coverage for:
  durable state transitions, duplicate submit, lease reclaim, heartbeat, backpressure, retry policy,
  dead-letter/manual recovery, cancellation, quota reserve/commit/release, tenant isolation, and
  log redaction.
- Queue module skeleton under `src/infrastructure/queue/` with bounded seams:
  - `application/QueueSpike.ts`
  - `domain/errors.ts`
  - `policy/backoff.ts`
  - `adapters/http/jobRoutes.ts`
  - `adapters/memory-store.ts`
  - `adapters/pglite/PostgresQueueStore.ts` (stub seam for later Drizzle wiring)
  - `adapters/bullmq/BullMqQueueStore.ts` (explicit rejected-option stub)
  - `persistence/schema.ts`
- Drizzle queue spike tables only in `src/infrastructure/queue/persistence/schema.ts`:
  `spike_jobs`, `spike_job_attempts`, `spike_idempotency_keys`, `spike_outbox_events`.
- Migration `src/infrastructure/database/migrations/0003_queue_spike.sql` + journal entry.
- HTTP spike routes mounted in `src/bootstrap/app.ts`:
  - `POST /v1/jobs`
  - `GET /v1/jobs/:jobId`
- Added stable error code `IDEMPOTENCY_KEY_REUSED` to the shared error envelope subset.
- Executable smoke `src/smoke/queue.ts` + script `pnpm queue:smoke`.
- Queue env parser `src/config/queue.env.ts` and `.env.example` queue keys.

## Decision

### Chosen option: custom Postgres-only queue

**One-line justification:** the repo already accepted PostgreSQL + Drizzle, and the spike proves the
required idempotency/lease/retry semantics without introducing a second stateful runtime dependency.

## Options considered

### 1. BullMQ + Redis
- Pros: mature queue primitives, familiar retry/worker model.
- Cons: second store, extra process to operate in dev/CI/VPS, duplicate durability story vs DB,
  harder to keep job creation + quota reservation + idempotency in one transaction.
- Result: rejected for this repo shape.

### 2. pg-boss / Graphile Worker
- Pros: Postgres-backed and operationally simpler than Redis.
- Cons: extra dependency weight and framework semantics beyond what the spike needed; still requires
  learning/integration overhead that does not materially improve the proven contract at B0-06 scale.
- Result: not selected for the spike.

### 3. Custom Postgres-only
- Pros: single durable store, easiest path to atomic job/idempotency/quota transaction boundaries,
  minimal dependency weight, no native modules, local/test friendly.
- Cons: more application code to own; later tasks must replace the spike stubs with real SQL claim/
  heartbeat/reaper queries and add production observability.
- Result: selected.

## Validation

- `test/infrastructure/queue/queue-spike.test.ts` proves all 14 acceptance items with failure injection.
- `pnpm queue:smoke` exercises duplicate submit, key reuse conflict, crash+reclaim, quota invariant,
  cross-tenant lookup, and redacted summary output.
- HTTP routes reuse the existing request-id middleware and shared error envelope.
- Queue payloads and logs store/redact fingerprints only; they never log clear idempotency keys,
  request payloads, source content, or signed URLs.

## VPS footprint

Measured dependency/runtime footprint for the chosen path:

- Extra production dependencies added for queue decision: **0 packages**.
- Extra always-on service processes required: **0** beyond the existing app/worker + PostgreSQL.
- Extra compressed dependency weight: **~0 KB** (no new production package installed for queueing).

Measured rejected BullMQ/Redis path footprint in this repo context:

- Would require **1 extra Redis 7 process** in local/CI/VPS.
- Would also require at least one additional production package plus Redis operational surface.
- The spike intentionally did **not** install BullMQ because the selected path already satisfied the
  contract without extra infrastructure.

## Rollback

- Remove `src/infrastructure/queue/`, migration `0003_queue_spike.sql`, queue env keys, route
  registration, and `IDEMPOTENCY_KEY_REUSED` if the owner rejects the queue direction.
- If a library-backed Postgres queue is later preferred, keep the persistence schema and replace the
  `PostgresQueueStore` stub + `QueueSpike` internals behind the existing store interface.

## Explicitly not delivered

- No real provider execution.
- No production-grade worker daemon/reaper loop.
- No persistent quota ledger tables beyond the in-memory spike accounting.
- No Redis setup, TLS, auth, or production infrastructure.
- No edits to `src/modules/auth/*` or auth-owned columns in `src/infrastructure/database/schema.ts`.

## Owner-open question

Recommended starting cap for the first real worker rollout: keep `QUEUE_WORKSPACE_CONCURRENCY=1` and
`QUEUE_WORKER_CONCURRENCY=4` until B2/B3 real workload timing is measured. Raise only after provider
latency and quota contention are observed on staging.
