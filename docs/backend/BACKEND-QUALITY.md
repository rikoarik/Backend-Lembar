# Backend Quality, Testing & Release

## Test layers

### Static

- Accepted D-014 type policy, lint, formatting, dependency and secret scan.
- OpenAPI lint/validation and generated artifact diff.
- Migration/schema validation.

### Unit

- Domain invariants/state transitions.
- Permission/policy decision functions.
- Quota reservation/commit/release.
- Idempotency fingerprints and conflicts.
- AI schema parsing and deterministic quality rules.
- Redaction and error mapping.

### Integration

- Real PostgreSQL in disposable test environment.
- Auth/session adapter behavior.
- Repository workspace scoping and foreign tenant adversarial cases.
- Transaction/outbox and job claim/retry.
- Object storage adapter through local/fake compatible service where safe.
- Provider calls mocked at HTTP/SDK boundary; no paid API in normal CI.

### Contract/API

- Every documented operation and error envelope.
- OpenAPI examples parse and generated client compiles.
- Backward-compatibility/breaking change check.
- `401/403/404/409/422/429` semantics.

### Worker/e2e

- API create → queue → worker → persisted result.
- Duplicate delivery and worker crash/restart.
- Source processing failure.
- AI schema/quality failure and bounded retry.
- Finalize → PDF artifact.
- Share revoke/expiry.

### AI eval

Offline dataset separate from unit tests. Produces versioned report for quality, latency, and
cost. Production model route cannot change solely because unit tests pass.

## CI baseline

1. Frozen install.
2. Secret scan.
3. Typecheck/lint/format.
4. Unit tests.
5. Disposable Postgres integration/tenant tests.
6. OpenAPI validation and breaking-change check.
7. Build API + worker.
8. Container smoke: API health and worker heartbeat.
9. Selected end-to-end job with mocked provider/storage.
10. Publish sanitized OpenAPI artifact on accepted branch/tag.

## Security gates

- Dependency/container scan.
- Auth/CSRF/CORS tests.
- IDOR/tenant tests for every tenant resource family.
- Upload parser/malware/quarantine tests before source release.
- SSRF suite before URL source release.
- Secret/log/content redaction tests.
- Rate-limit and idempotency race tests.

## Migration gates

- Forward migration tested on production-like synthetic data.
- Lock/downtime risk reviewed.
- Rollback/forward-fix documented.
- Backward compatibility with previous running app during deploy.
- Backup/restore point confirmed before destructive step.

## Performance

- Define API SLOs after baseline; do not optimize invented bottlenecks.
- Load test high-risk endpoints: login, catalog, create job, job polling, history, share access.
- Worker concurrency bounded by DB/provider/storage limits.
- PDF memory/time tested at maximum supported question count.

## Release

- Immutable image/artifact and migration version.
- Env schema validated per process.
- Staging smoke with pinned frontend contract.
- Backup and rollback available.
- Dashboards/alerts/runbooks live.
- Feature flag/canary for AI route.
- Owner accepts outcome; agent does not deploy production without explicit authorization.
