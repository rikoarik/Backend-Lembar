# Domain, Integration, and Analytics Event Catalog

## Naming and envelope

Domain/integration event names use past tense: `assessment.generation_requested.v1`.

```json
{
  "eventId": "evt_opaque",
  "eventType": "assessment.generation_requested.v1",
  "occurredAt": "ISO-8601",
  "producer": "lembar-api",
  "workspaceId": "ws_opaque",
  "actorId": "acct_opaque_or_null",
  "correlationId": "opaque",
  "payload": {}
}
```

Internal IDs are included only for authorized internal consumers. External analytics receives
an allowlisted minimized projection.

## Identity/workspace events

| Event | Trigger | Minimum payload |
| --- | --- | --- |
| `account.registered.v1` | account+personal workspace commit | account ID, method category |
| `session.created.v1` | login success | account ID, session ID, auth method |
| `session.revoked.v1` | logout/security revoke | session ID, reason |
| `workspace.activated.v1` | active context switch | from/to workspace ID/type |
| `invitation.created.v1` | school invite commit | invitation ID, school ID, expiry |
| `invitation.accepted.v1` | membership activated | invitation/member IDs |
| `membership.changed.v1` | role/status change | member ID, old/new safe state |

No email, name, credential, activation token, or IP in general event payload.

## Source events

| Event | Trigger | Payload |
| --- | --- | --- |
| `source.upload_intent_created.v1` | intent commit | source ID, type, declared byte class |
| `source.processing_requested.v1` | upload verified | source ID/version, job ID |
| `source.ready.v1` | extraction/index commit | source/version, page/text-size class |
| `source.failed.v1` | terminal failure | source/job IDs, failure code |
| `source.deletion_requested.v1` | access disabled | source ID |
| `source.deleted.v1` | derived purge complete | source ID, deletion request ID |

No filename, text, storage key, or signed URL.

## Assessment events

| Event | Trigger | Payload |
| --- | --- | --- |
| `assessment.created.v1` | draft commit | assessment ID, type, grade/subject IDs |
| `assessment.generation_requested.v1` | job/outbox commit | assessment/version/job/reservation IDs |
| `assessment.draft_ready.v1` | generation result commit | assessment/version, usable/flagged counts |
| `assessment.question_reviewed.v1` | review action | question ID, action/reason enum |
| `assessment.finalized.v1` | immutable version commit | assessment/version, question count |
| `assessment.duplicated.v1` | new draft commit | source/new assessment IDs |
| `assessment.archived.v1` | archive commit | assessment ID |

No question text, options, answer, teacher focus, example, or prompt.

## Job/output events

| Event | Trigger | Payload |
| --- | --- | --- |
| `job.status_changed.v1` | durable transition | job ID/kind/from/to/stage/attempt |
| `export.requested.v1` | export commit | artifact key ID/job/version/options code |
| `export.ready.v1` | artifact commit | artifact ID, version, page/byte class |
| `export.failed.v1` | terminal render failure | artifact/job ID, failure code |
| `share.created.v1` | token record commit | share ID, package scope, expiry |
| `share.revoked.v1` | revoke commit | share ID, reason |

No artifact bytes, full checksum/key, share token, or download URL.

## Commerce events

| Event | Trigger | Payload |
| --- | --- | --- |
| `quota.reserved.v1` | ledger reserve | reservation/job/bucket IDs, unit count |
| `quota.committed.v1` | usable result | reservation/job IDs, committed units |
| `quota.released.v1` | failure/cancel | reservation/job IDs, units, reason |
| `subscription.changed.v1` | reconciled provider state | subscription ID, old/new state, plan version |
| `entitlement.changed.v1` | effective policy change | workspace, entitlement version/reason |

No payment instrument, webhook body, customer email, provider secret.

## Product analytics events

Client/server names can use action form with version, for example:

- `landing.viewed.v1`
- `landing.cta_clicked.v1`
- `generate.form_started.v1`
- `generate.form_valid.v1`
- `generate.submitted.v1`
- `review.opened.v1`
- `review.action_applied.v1`
- `output.opened.v1`
- `output.print_requested.v1`
- `output.download_requested.v1`
- `template.run_requested.v1`

Allowed dimensions are defined in product analytics spec. Free text/content/token/filename is
prohibited.

## Delivery and evolution

- Transactional outbox for domain/integration events.
- Consumer is idempotent by event ID.
- At-least-once delivery expected.
- Event schema is versioned; additive optional fields do not require new major.
- Required field removal/meaning change creates `.v2` and migration window.
- Store minimum retention needed for replay/audit; event log is not a shadow copy of content.
- Failed consumer goes to bounded retry/dead-letter/manual recovery without blocking source
  transaction.

