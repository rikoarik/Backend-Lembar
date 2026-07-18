# Backend Execution Plan

Sprints are a queue, not authorization. Exactly one backend task may be `in_progress`.

## B0 — Repository and decision spikes

| Task  | Outcome                                                           | Dependency                   |
| ----- | ----------------------------------------------------------------- | ---------------------------- |
| B0-01 | Bootstrap accepted Node stack, API/worker entrypoints, tooling/CI | D-014/D-016/D-018 accepted  |
| B0-02 | Per-process env schemas, redaction, `.env.example`                | B0-01 accepted               |
| B0-03 | OpenAPI/error/request-id baseline and artifact publishing         | B0-01 accepted               |
| B0-04 | PostgreSQL/ORM migration PoC; decide D-003                        | B0-01 accepted               |
| B0-05 | Auth/session PoC; decide D-002                                    | B0-04 accepted               |
| B0-06 | Queue/idempotency PoC; decide D-004                               | B0-04 accepted               |
| B0-07 | Private storage/upload/PDF PoC                                    | Storage decision candidate   |
| B0-08 | Product AI adapter/structured-output/eval smoke with mocks         | D-019 candidate + task       |

## B1 — Identity, workspace, catalog

- B1-01 Account/session integration.
- B1-02 Personal workspace/membership/tenant context.
- B1-03 Permission and cross-tenant adversarial suite.
- B1-04 Curriculum/catalog versioning and read API.
- B1-05 `/v1/me` and contract integration gate.
- B1-06 Marketing content schema, migration, and published-only ETag read API.

## B2 — Sources and generation foundation

- B2-01 Upload intent/private object lifecycle.
- B2-02 Scan/extraction job and source states.
- B2-03 Assessment config/draft/idempotency.
- B2-04 Quota reservation ledger.
- B2-05 End-to-end job status and failure policy.

## B3 — AI generation and quality

- B3-01 Retrieval baseline and source references.
- B3-02 Blueprint schema/pipeline.
- B3-03 Question Structured Output generation.
- B3-04 Deterministic quality checks and repair cap.
- B3-05 Eval dataset/report, cost, model routing decision D-013.

## B4 — Review and finalization

- B4-01 Question edit/version/audit.
- B4-02 Regenerate one question with quota/idempotency.
- B4-03 Optimistic conflict handling.
- B4-04 Finalization invariants and immutable version.
- B4-05 Contract/integration/security gate.

## B5 — Output and library

- B5-01 Print document data model/template contract.
- B5-02 PDF worker/artifact lifecycle.
- B5-03 Secure share link.
- B5-04 History/bank private/template.
- B5-05 Visual/security/retry/retention gate.

## B6 — Commerce, admin, pilot hardening

- B6-01 Entitlement/quota enforcement.
- B6-02 Payment only after D-008/D-009.
- B6-03 Superadmin safe operations/audit.
- B6-04 Backup restore/load/incident readiness.
- B6-05 Paid teacher pilot gate.
- B6-06 Superadmin CMS draft/preview/publish/unpublish/restore and audit.

## B7 — School pilot `P1`

- B7-01 School workspace/invitation/membership.
- B7-02 Seats/shared quota.
- B7-03 School bank/template/branding.
- B7-04 Usage/reporting/invoice integration.
- B7-05 Tenant/admin adversarial and pilot gate.

## Task acceptance minimum

Each task includes migrations if applicable, tests, OpenAPI impact, security/privacy review,
observability, exact commands, rollback/migration note, and explicit non-scope. Handoff status
is `READY_FOR_OWNER_REVIEW`; then stop.
