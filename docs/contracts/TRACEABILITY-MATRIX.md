# Requirements Traceability Matrix

This matrix links product requirements to user surface, backend responsibility, planned task,
and acceptance evidence. Update when an FR or task changes.

| Requirement group | Frontend surface | Backend module/API | Planned tasks | Key evidence |
| --- | --- | --- | --- | --- |
| FR-PUB-001 landing | `/` | lead/feature metadata if any | F1-01,F1-02 | claim audit, responsive/a11y/perf |
| FR-PUB-002 school lead | `/untuk-sekolah` | lead adapter/ops | F1-03,B6-04 | consent, spam/rate limit, delivery |
| FR-CMS-001 public content | marketing routes | public marketing read | F1-06,B1-06 | ETag, fallback, schema, visible pixels |
| FR-CMS-002 authoring | `/ops/content` | ops marketing commands | F6-05,B6-06 | role, conflict, audit, preview/publish |
| FR-CMS-003 fixed blocks | renderer/editor | versioned content schema | F1-06,F6-05,B1-06 | compatibility, unsafe content rejection |
| FR-ID-001 identity | identity routes | identity/auth | F1-04,B1-01,X1-01 | session/CSRF/recovery/e2e |
| FR-WS-001 personal | app shell | workspace/membership | F2-01,B1-02 | atomic create, tenant tests |
| FR-WS-002 active workspace | switcher | `/me/active-workspace` | F2-01,B1-02 | cache clear, adversarial tests |
| FR-WS-003 school membership | `/school/guru` | invitation/membership | F6-02,B7-01 | activation/revoke/last-admin |
| FR-CAT-001/002 catalog | generate/dashboard | catalog | F3-01,B1-03 | version/readiness fixtures |
| FR-SRC-001 catalog source | generate source choice | source/catalog | F3-01,B1-03 | rights/version gate |
| FR-SRC-002 PDF | uploader | source upload/ingestion | F3-02,B2-01,B2-02 | MIME/scan/extract/delete |
| FR-SRC-003 insufficient | source/job states | retrieval/source | F3-02,F3-03,B2-03 | no hallucinated padding |
| FR-GEN-001/002 config | `/app/generate` | assessment config | F3-01,B3-01,X3-01 | dependent fields/idempotency |
| FR-GEN-003 async | job progress | jobs/queue | F3-03,B3-02 | reload/retry/crash tests |
| FR-AI-001 blueprint | review metadata | generation | B3-03,B3-04 | structured schema/distribution |
| FR-AI-002 question | review editor | generation/assessment | F4-01,B3-04 | schema/source/answer integrity |
| FR-AI-003 quality | flags | quality/eval | F4-01,B3-05 | offline eval/teacher rubric |
| FR-REV-001 quick | review list | question review | F4-01,B4-01 | full keyboard/state coverage |
| FR-REV-002 detail | detail review | question review | F4-02,B4-01 | one-by-one/autosave |
| FR-REV-003 regenerate | question action | regeneration job | F4-02,B4-01 | old version preserved |
| FR-REV-004 autosave/conflict | review status | optimistic versioning | F4-02,B4-01 | concurrent edit tests |
| FR-FIN-001 finalize | finalize dialog | assessment finalize | F4-03,B4-02 | immutable/idempotent/audit |
| FR-OUT-001 print | output center | canonical artifact | F5-01,B5-01,X5-01 | same artifact/golden A4 |
| FR-OUT-002 PDF | output center | export/storage | F5-01,B5-01 | private/signed/checksum |
| FR-OUT-003 web link | share/viewer | share link | F5-02,B5-02 | scope/expiry/revoke/no-index |
| FR-OUT-004 DOCX | hidden until accepted | future export | TBD | D-010 and PoC |
| FR-LIB-001 history | `/app/lembar` | assessment read model | F5-03,B5-03 | cursor/filter/action states |
| FR-LIB-002 bank | `/app/bank-soal` | private bank | F5-04,B5-03 | snapshot/private/delete |
| FR-LIB-003 template | `/app/template` | template | F5-04,B5-03 | run/version/archive |
| FR-COM-001 entitlement | plan/guards | commerce | F6-01,B6-01 | server enforcement |
| FR-COM-002 quota | usage | ledger/jobs | F6-01,B6-01 | concurrency/duplicate/failure |
| FR-COM-003 seats | school admin | membership/commerce | F6-02,B7-01 | cap/pooled usage |
| FR-ADM-001 superadmin | `/ops` | operations | F6-03,B6-03 | least privilege/audit |
| FR-ADM-002 school admin | `/school` | school | F6-02,B7-01 | content privacy/admin actions |
| FR-X-001 authorization | all guards | all services | every task | tenant adversarial suite |
| FR-X-002 audit | status/ops | audit | B1+,B6-03 | integrity/search/redaction |
| FR-X-003 analytics | approved events | event/outbox | F/B tasks | event schema/no content |
| FR-X-004 localization | all copy | locale/date contracts | all FE/API | id-ID/timezone fixtures |
| FR-X-005 deletion | settings/actions | lifecycle | F5+,B2+,B8-02 | purge/backup/tombstone |

## Change rule

An FR is `Implemented` only when:

- required decisions accepted;
- both surface and backend contract landed where applicable;
- evidence listed above exists;
- security/privacy/accessibility/analytics acceptance passes;
- task handoff accepted by owner;
- release gate status updated.
