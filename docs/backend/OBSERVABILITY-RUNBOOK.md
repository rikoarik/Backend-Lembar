# Observability and Incident Runbook

## Objectives

Enable a small team to detect user-impacting failure, diagnose it without reading private
content, recover safely, and learn from incidents.

## Service-level indicators

- API request success/latency by operation and status class.
- Auth/session failures by safe reason category.
- Queue depth and oldest queued/running age by job kind.
- Job success/partial/failure/cancel and duration.
- Provider request success/rate-limit/latency/usage by route ID.
- Source processing success and failure category.
- PDF success, duration, page/byte size class.
- DB pool saturation/query latency/deadlocks.
- Object storage/error/latency.
- Notification and webhook delivery/reconciliation.
- Quota reservation stuck/imbalance invariant.

## Initial pilot objectives

These are internal targets, not public SLA, and must be adjusted from measured baseline:

- API availability target 99.5% during pilot window excluding planned maintenance.
- No sustained queue oldest-age beyond an owner-defined threshold.
- Generation/export terminal state within task-specific timeout or actionable failure.
- Zero known cross-tenant disclosure and zero secret/content logging.

Exact latency/success thresholds are set after PoC/load/eval evidence.

## Structured log envelope

Allowed baseline:

```json
{
  "timestamp": "ISO-8601",
  "level": "info",
  "service": "lembar-api",
  "version": "build-id",
  "environment": "staging",
  "requestId": "opaque",
  "traceId": "opaque",
  "operation": "createAssessment",
  "status": "accepted",
  "durationMs": 42
}
```

IDs are internal opaque references only when useful. Do not log account email/name, school name,
source/question/prompt text, file name, cookie/token, full storage key/URL, provider request body,
payment payload, or raw exception from external provider.

## Tracing

Trace API → outbox/queue → worker → adapter using correlation IDs. Sampling increases on safe
error metadata but never captures content. Do not put secrets or user text in span names/
attributes.

## Alerts

Page/urgent:

- suspected tenant/security/secret disclosure;
- auth outage or widespread login failure;
- DB unavailable/data integrity/quota invariant violation;
- production error/job failure above sustained impact threshold;
- queue stuck/worker dead with active users;
- artifact/share access bypass.

Ticket/nonurgent:

- individual terminal user-input error;
- one provider retry recovered;
- capacity trend, noisy endpoint, cost drift under emergency threshold.

Alerts include runbook link, environment, impact, safe dashboard, recent deploy, and owner.

## Incident severity

- **SEV-0:** confirmed/suspected sensitive disclosure, credential compromise, destructive data
  loss, cross-tenant access. Stop affected capability and escalate immediately.
- **SEV-1:** broad production outage or critical workflow unavailable.
- **SEV-2:** degraded subset, workarounds exist, limited cohort.
- **SEV-3:** minor defect/no immediate user impact.

## Incident loop

1. Declare severity, incident lead, timestamp, affected environment.
2. Preserve evidence without copying sensitive content to chat/ticket.
3. Contain: flag/route/queue/deploy rollback/revoke credentials as appropriate.
4. Assess scope from safe metadata and audit.
5. Communicate facts, uncertainty, next update time; no speculation.
6. Recover and validate with user-path/synthetic probe.
7. Monitor; close only after stability.
8. Blameless postmortem with root cause, contributing controls, actions/owners/dates.

## Common playbooks

### AI provider degradation

- disable new generation or route only to pre-evaluated fallback;
- keep existing review/output available;
- allow queue/backoff with visible state;
- do not switch provider/model silently;
- cap retries/cost and communicate.

### Queue/worker stuck

- inspect depth/oldest lease/worker heartbeat;
- stop new claims if corruption suspected;
- distinguish probe failure from job death;
- recover expired leases idempotently;
- verify quota and duplicate effects.

### PDF renderer failure

- disable export creation, retain final assessments;
- recycle isolated renderer/workers;
- validate golden fixture before reopen;
- prevent corrupt artifact ready state.

### Secret exposure

- revoke/rotate first; do not merely delete commit/log;
- identify access/usage scope and affected systems;
- invalidate sessions/URLs if relevant;
- preserve incident record and notification/legal decision.

### Tenant access concern

- disable affected route/feature;
- audit actor/request/resource/workspace metadata;
- do not ask user to send private source in insecure channel;
- run adversarial regression before reopen.

## Operational dashboards

- API and auth health.
- Queue/jobs by kind/stage/age.
- Provider quality/latency/cost metadata.
- DB/storage capacity.
- Quota/payment reconciliation.
- Release comparison and feature flags.

Dashboard access follows least privilege and production audit.

