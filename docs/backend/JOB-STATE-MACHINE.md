# Asynchronous Job and Idempotency Specification

Long source extraction, AI generation, question regeneration, and PDF export run outside the
HTTP request. Queue choice remains D-004; business semantics are queue-independent.

## Job kinds

- `source_ingestion`
- `assessment_generation`
- `question_regeneration`
- `export_pdf`
- future notification/billing reconciliation jobs only by task/ADR

## Durable states

```text
created -> queued -> running -> succeeded
                    |       -> partially_succeeded
                    |       -> retry_wait -> queued
                    |       -> failed
created/queued -> cancelled
running -> cancellation_requested -> cancelled|succeeded|failed
```

`stage` is kind-specific and does not replace durable state.

## Generation stages

`preparing_source`, `building_blueprint`, `generating_questions`, `validating_questions`,
`persisting_draft`.

Export stages: `building_print_model`, `rendering_html`, `rendering_pdf`, `storing_artifact`.

Source stages: `verifying_upload`, `scanning`, `extracting`, `chunking`, `indexing`.

UI receives neutral stage labels, never provider chain-of-thought or raw error.

## Job record minimum

- ID, kind, workspace ID, actor account ID;
- aggregate/resource ID and version;
- durable status/stage;
- attempt/max attempts;
- queue message/dedup key where applicable;
- idempotency key + request fingerprint;
- progress current/total only when real;
- scheduled/started/heartbeat/finished timestamps;
- cancellation timestamp/actor;
- failure code/category/retryable, redacted detail reference;
- input/schema/config/prompt/model/renderer versions;
- quota reservation and cost correlation IDs;
- result reference, not duplicated sensitive payload.

## API creation transaction

In one transaction where possible:

1. validate membership/resource/source/entitlement;
2. resolve idempotency key and fingerprint;
3. create/update aggregate draft;
4. reserve quota;
5. create job `created`/`queued`;
6. write outbox event;
7. commit;
8. publisher delivers queue message.

Same key + same fingerprint returns original result. Same key + different fingerprint returns
`IDEMPOTENCY_KEY_REUSED` conflict.

## Delivery semantics

Queue can be at-least-once. Worker must make business effects exactly-once through:

- atomic compare-and-set state claim;
- unique job/resource version constraints;
- idempotent provider/artifact result persistence;
- deterministic export/cache key;
- quota ledger unique references;
- transactional outbox for follow-up events.

Do not rely on queue “exactly once” marketing.

## Lease and heartbeat

- Worker claim has lease/owner/expiry.
- Running job heartbeats at a bounded interval.
- Reaper may recover only after lease expiry plus safety margin.
- Failed liveness probe alone does not mark job failed.
- Recovery checks for committed result before retrying external work.

## Retry policy

Retryable examples:

- network timeout;
- rate limit with retry-after;
- transient provider/DB/storage unavailable;
- worker crash before durable effect.

Terminal/user-action examples:

- invalid/encrypted/unsupported PDF;
- insufficient source;
- unauthorized/deleted source;
- invalid state/version;
- repeated schema/quality failure over cap;
- rejected content/policy.

Use exponential backoff with jitter, provider retry-after, per-kind cap, and deadline. Record
failure category per attempt without source/prompt text.

## Partial success

Generation may finish fewer usable questions only when product policy allows:

- store valid questions and blocking quality issues;
- status `partially_succeeded`;
- state exact count and missing reason;
- quota commit policy follows `BILLING-QUOTA-SPEC.md`;
- teacher can review, retry missing items, or edit configuration.

Never pad unsupported questions merely to reach requested count.

## Cancellation

- Allowed before terminal state; capability depends on current stage/provider.
- Cancellation is a request; external call may not stop immediately.
- Worker checks between safe stages.
- If usable result commits before cancellation wins, return succeeded with audit.
- Quota reservation releases/commits according to actual effect.
- Cancellation does not delete existing draft/source automatically.

## Dead-letter/manual recovery

After retry cap:

- job becomes terminal `failed` with stable failure code;
- restricted diagnostic metadata retained;
- alert based on rate/impact, not every user error;
- ops can retry only through audited command that creates attempt/recovery record;
- no editing database status by hand as normal operation.

## Backpressure

- Per-workspace/account concurrency and rate limit.
- Global provider/model route concurrency.
- Worker concurrency configurable and bounded.
- Queue depth/oldest-age alert.
- Graceful shutdown stops new claims, extends/finishes lease safely, and exits by deadline.

## User polling contract

- `GET job` is authorized by workspace/resource.
- ETag/`updatedAt` allows efficient backoff.
- Recommended polling: fast initial, exponential to capped interval, stop terminal/background.
- SSE may be added without changing durable job schema.
- Page reload can recover from stored job ID/assessment relationship.

## Tests

- duplicate API submit;
- message delivered twice;
- worker crash before/after provider call and before/after commit;
- lease expiration and concurrent reclaim;
- quota reserve/commit/release exactly once;
- cancelled during each stage;
- deleted/revoked source before execution;
- partial success;
- retry cap/manual recovery;
- cross-tenant job ID attack;
- secret/content redaction.

