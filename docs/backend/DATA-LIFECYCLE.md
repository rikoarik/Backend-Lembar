# Data Classification, Retention, and Deletion

Retention values are policy decisions finalized before external pilot. This document defines
classes and required behavior, not legal advice.

## Data classes

| Class | Examples | Sensitivity |
| --- | --- | --- |
| Identity | name, login identifier, membership | personal/confidential |
| Auth secret | session, recovery token hash, credential material | restricted |
| School | school profile, admin contacts, contract | confidential |
| Source | uploaded PDF, extracted text, passages | restricted/private content |
| Assessment | questions, answers, explanations, review | restricted/private content |
| Artifact/share | PDF, answer key, share token | restricted/capability |
| Billing | subscription/provider IDs, ledger | confidential |
| Audit | actor/action/target metadata | confidential/immutable policy |
| Telemetry | request IDs, metrics, aggregate events | internal; content prohibited |

MVP intentionally has no student account, answer, grade, or roster data.

## Storage principles

- Minimize fields and copies.
- Encrypt in transit; storage encryption according to chosen provider/environment.
- Private object storage and least-privilege access.
- Production data never copied to local/preview/test.
- Backups inherit classification and deletion/expiry constraints.
- Secret values never stored in business tables/logs.

## Proposed retention schedule template

Owner/legal fills exact duration before pilot:

| Object | Active retention | After deletion/expiry | Backup treatment |
| --- | --- | --- | --- |
| Account/profile | while account active | pending policy window | expires with backup cycle |
| Session/recovery | short security lifetime | immediate invalidate | not restored as valid |
| User PDF/source | while user keeps it | access immediate off; purge SLA TBD | tombstone + backup expiry |
| Extracted passages | tied to source | purge with source | same |
| Draft/final assessment | while workspace keeps it | trash/purge policy TBD | same |
| Artifact | configurable/reproducible | expire/delete object | same |
| Share token | until revoked/expired | access immediate off | never reactivated by restore |
| Audit | fixed compliance/security period | controlled expiry | integrity preserved |
| Analytics | shortest useful aggregate window | delete/aggregate | no raw content |

## Deletion semantics

Distinguish:

- archive: hidden from normal list, recoverable;
- soft delete/trash: access restricted, restore within policy window;
- purge requested: asynchronous deletion workflow;
- legal hold: documented exception with restricted visibility;
- anonymize: remove identity while retaining allowed aggregate/record.

UI must not say “permanently deleted” before purge semantics and backup expiry are true.

## Source deletion

1. Verify permission and dependencies.
2. Revoke new generation use immediately.
3. Invalidate upload/download intents.
4. Mark deletion request and enqueue idempotent purge.
5. Delete object, extracted text, index/vector entries, temp files, and derived caches.
6. Handle assessment provenance references according to policy without exposing removed content.
7. Record completion metadata, not deleted source content.

## Account/workspace deletion

- Personal account deletion handles memberships separately.
- School workspace deletion requires admin/contract guard and cannot be triggered by one teacher.
- Ownership of school-created content follows written policy.
- Active subscription, legal/audit, and unpaid obligations get explicit handling.
- Export/portability decision and identity verification precede destructive action.

## Provider data

For AI, email, payment, storage, analytics, error tracking:

- document processor, purpose, fields/content sent, region, retention, training/default settings,
  subprocessors, deletion path, and contract;
- configure provider storage/training intentionally;
- avoid sending identity when job content alone is enough;
- retain provider request IDs only when safe/useful.

## Backup restore invariants

- Restoring backup must reapply tombstones/revocations created after snapshot.
- Expired/revoked session/share/invite must not become valid.
- Restore drill verifies tenant ownership and object consistency.
- Backup access audited and limited.

## Data subject and incident workflows

Before launch define intake, identity verification, search/export/correction/deletion process,
legal exceptions, SLA, and responsible owner. A privacy/security incident follows documented
severity, containment, evidence preservation, notification decision, and postmortem.

## Acceptance

- Field-level data inventory mapped to class/owner/retention.
- All object copies and processors identified.
- Delete integration tests cover DB, object, index, cache, artifact, share.
- Backup restore does not resurrect revoked capability.
- Product copy matches actual lifecycle.

