# B0-08 — Product AI provider adapter spike (D-019 candidate)

## Status

`OWNER_PENDING`. Production provider selection is **deferred** until
the owner accepts `D-019`. The spike ships a provider-neutral adapter
boundary, mock-first coverage, and adds no live secret slot. Owner
choice reduces to one of three values once D-019 is on the agenda.

## Context

`lembar` needs a product-runtime AI provider for blueprint + question
generation (B3-02/B3-03) and review critic pipelines. D-019 stays open
because privacy, quality, latency, and cost evidence must precede a
paid contract. We cannot ship customer data to a paid provider before
owner approval, and we want local dev/test/CI to stay independent of
any third-party account.

The spike proves a provider-neutral adapter seam, mock-first coverage,
structured-output handling including a bounded repair cap, redacted
audit rows, and env-driven driver selection. It does **not** deploy a
live call. It reuses the accepted B0-06 queue and the B0-09 audit-row
redaction pattern (fingerprint-only payload columns, no raw prompt
or response text).

## Decision

**D-019 candidate recommendation** — `provider-neutral adapter with
mock-first default`. Only one of these three may be accepted; this
spike produces evidence for `option B` and explicitly defers
`options A` and `C` if owner prefers something else.

### Provider candidates considered

| Option | Summary | Evidence produced here |
| --- | --- | --- |
| A — direct OpenAI | Single-vendor adapter behind `OPENAI_API_KEY` | Adapter scaffold with HTTP envelope mapping; no live call |
| B — provider-neutral adapter (mock-first default) | `ProductAiAdapter` contract + pluggable drivers; mock is dev/test default; live driver only when `AI_DRIVER=openai` + key | Full spike: schema repair, redacted audit, env parser, smoke, tests, ADR |
| C — open-source local runner | Local model runner (llama.cpp/ollama/vLLM) inside the worker runtime | Out of scope — depends on later task and would add new deps |

### Recommendation

Ship the spike behind option B with `AI_DRIVER=mock` as the default.
Owner may switch to option A by `AI_DRIVER=openai` (env-driven, no
code change) once a real secret slot exists. Owner may later widen to
option C by adding a third adapter file under
`src/infrastructure/ai/adapters/local/`. The spike never auto-upgrades
the model or driver on its own.

## Driver selection

`parseAiEnv(env)` is the single typed source of truth. Defaults:

- `AI_DRIVER=mock` (no key required).
- Setting `AI_DRIVER=openai` without `OPENAI_API_KEY` falls back to
  `mock` so production deploys cannot accidentally live-fire from a
  missing-secret environment.
- `.env.example` lists `OPENAI_API_KEY` as an empty placeholder. The
  repo **never** commits a real value.

## Provider boundary

The B0-08 spike is provider-shaped: it returns discriminated outcomes
(`succeeded | schema_invalid | rate_limited | refused | error`). The
queue (B0-06) remains the transport; the adapter is the seam. A live
provider must support schema-constrained structured output (or a
validated parsing layer with equivalent failure handling). Data
storage behavior is configured at the worker layer (TTL / no-store),
never implicit provider defaults.

Model ID and reasoning/temperature knobs live in
`ProductAiService` runtime configuration, not in frontend code. The
spike does not pick a specific model name; `AI_MODEL_ID` defaults to
`mock-fixture-v1` and is intentionally non-committal.

## Privacy review

What may leave the worker:

- prompt template ID (e.g. `assessment.blueprint.v3`)
- schema version
- provider model ID
- request token estimate (`Buffer.byteLength / fallback`)
- response token count (`Buffer.byteLength / fallback`)
- prompt / response fingerprints and byte lengths (SHA-256 first 12 hex)
- failure category (`succeeded | schema_repair | rate_limited |
  refused | error`)

What never leaves the worker:

- the raw prompt text (never logged, never persisted)
- the raw response body (never logged, never persisted; only its
  fingerprint survives to the audit row)
- the `OPENAI_API_KEY` value
- tenant PII, recipient strings, source excerpts, question stems

`.env.example` exposes the variable name `OPENAI_API_KEY` only. CI
runs with `AI_DRIVER=mock` only — production secrets are never read
by the spike. The smoke script refuses to instantiate the OpenAI
adapter unless an explicit, in-process constructor call is made
(which the smoke script does not do).

## Structured-output reliability

`JsonSchemaValidator` (Ajv2020 reuse, no new deps) validates the
provider payload against the prompt-template `schema` argument. A
schema-repair path runs until the cap — default `AI_SCHEMA_REPAIR_MAX=1`
— then returns the stable code `SCHEMA_VALIDATION_FAILED`. The
audit row records `outcome='schema_repair'` once per repair attempt
plus a final audit row inside the service.

Cap policy: each increment of the cap costs a full round trip.
Settings above `1` are allowed (`AI_SCHEMA_REPAIR_MAX` bounded
`0..5`) so B3 can raise the cap once model reliability evidence
justifies it. The spike keeps the default at `1` so the
acceptance script can read it directly.

## Latency + cost model

Measured here (deterministic, in-process, mock driver):

- Mock latency floor at p100 in the spike: ~0 ms per call
  (no I/O, no clock skew). The exact floor depends on hardware;
  the smoke print surfaces `mockLatencyFloorMs`.
- Projected live (`gpt-4o-mini` style structured output, ~1.2k
  tokens in / 800 tokens out, North America latency bands):
  `1.5s p50`, `3.5s p95`, `9s p99` with retry-after backoff layered
  on `RATE_LIMITED`. These are public-pricing-page-order figures,
  not measured against a paid account.
- Projected per-question USD cost band — structured output pricing
  depends on the prompt template; the spike keeps the cost band
  visible by recording `request_token_estimate` (with a
  `AI_TOKEN_CHARS_FALLBACK=4` fallback). For a 1.2k in / 0.8k out
  question at `gpt-4o-mini` rates ($0.15/$0.60 per 1M tokens),
  each call lands in the `$0.0005..$0.001` band. The spike does
  **not** commit to that rate — it surfaces the cost formula so
  B3-D can pull real numbers once a paid account exists.

## Audit shape (B0-09-style)

`ai_jobs_audit` (one row per `ProductAiService.run` outcome) is the
single durable artefact of the spike. Columns:

- `workspace_id`, `actor_id`, `prompt_template_id`, `schema_version`
- `provider_model_id`, `driver`, `outcome`, `schema_repair_attempts`
- `request_token_estimate`, `response_token_count`, `tokens_in_estimate`
- `prompt_fingerprint`, `prompt_byte_length`
- `response_fingerprint`, `response_byte_length`
- `redacted_error` (failure category only, no provider body)
- `latency_ms`, `job_id`, `redacted_detail`, `created_at`

DB-level CHECK constraints on `driver` (`mock | openai`) and
`outcome` keep accidental driver injection out of the audit table
(mirroring the B0-09 contract).

## Rollout

1. Migration `0008_product_ai_audit.sql` adds the additive
   `ai_jobs_audit` table only.
2. `src/infrastructure/ai/{domain,application,adapters,persistence}`
   is provider-shaped; no `OPENAI_API_KEY` is read in production.
3. No new HTTP surface is shipped — the smoke script and tests prove
   the spike end to end.
4. `pnpm ai:smoke` exits `0` on success and prints a redacted JSON
   envelope covering privacy, latency, schema-repair attempts, and
   mock-vs-live audit counts.

## Rollback plan if owner rejects option B

- `git revert` the B0-08 commits restores the `dev` HEAD without
  touching any other module — the migration is additive, the smoke
  script is additive, the tests live under their own folder.
- If owner chooses **A** directly, keep `OpenAiAdapter` and the env
  parser, remove `MockAiAdapter` from the constructor and update
  `ProductAiService` to default to `openai`. The audit schema does
  not change.
- If owner chooses **C**, add a third file under
  `src/infrastructure/ai/adapters/local/`, register the driver value
  `local` in `parseAiEnv`, and route provider requests through the
  runner. No audit-table changes needed.

## Deferred items (owner decisions)

- D-019 final choice (mock-first default accepted here; direct
  OpenAI vs open-source local remains owner decision).
- Real `OPENAI_API_KEY` secret slot when the staging environment is
  ready; the spike refuses to read keys from `.env.example`.
- Eval program (B3-02 / B3-03) — gold dataset, schema success rate,
  source-supported rate.
- Async critic on higher-risk items.
- Async outbox/worker for AI generation drains — relies on B2-N.
- Tenant-isolated audit reads.

## Acceptance evidence map

| Acceptance | Evidence |
| --- | --- |
| `pnpm typecheck && pnpm lint && pnpm format:check && pnpm build` green | gate output captured in handoff |
| `pnpm test` stays at or above `88/30` baseline | vitest output captured in handoff |
| mock determinism across N calls | `test/infrastructure/ai/mock-adapter.test.ts` |
| structured success + repair cap + SCHEMA_VALIDATION_FAILED | `test/infrastructure/ai/product-ai-service.test.ts` |
| rate-limit / refusal mapping to envelope codes | `test/infrastructure/ai/product-ai-service.test.ts` |
| no real provider call when `AI_DRIVER=mock` | `parseAiEnv` fallback + smoke `liveAdapterInstantiated=false` |
| redaction of prompt/response in audit rows | `test/infrastructure/ai/product-ai-service.test.ts` |
| `pnpm openapi:validate && pnpm openapi:breaking` clean | gate output captured in handoff (no path added) |
| `pnpm db:check` clean | `0008_product_ai_audit.sql` additive with seeded meta snapshot |
| `pnpm ai:smoke` green | smoke output captured in handoff |
