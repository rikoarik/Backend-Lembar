# End-to-End Quality Plan

## Quality layers

1. Static formatting/type/schema/secret/dependency gates.
2. Unit tests for domain/rules/components.
3. Integration tests with ephemeral PostgreSQL/queue/storage adapters.
4. OpenAPI/generated client contract tests.
5. Browser/API/worker end-to-end journeys.
6. Tenant/security adversarial tests.
7. AI offline eval and educator review.
8. PDF golden/physical print checks.
9. Accessibility, performance, resilience, backup/restore/load rehearsal.

## Synthetic fixtures

- Personal teacher with empty/populated workspace.
- School admin + two teachers + suspended/revoked member.
- Superadmin with scoped permissions.
- Versioned curriculum/grade/subject/material dummy data.
- Rights-safe synthetic PDFs: normal, long, scan, encrypted, malicious/noisy, insufficient.
- Assessment packages 5/20/50 questions, long Indonesian text, passage, special glyphs.
- Entitlement at zero/one/max, grace/past due, seat cap.
- Share active/expired/revoked and student/teacher package variants.

No real teacher/student/school data in tests or screenshots.

## Critical journeys

- Landing → register → personal workspace → first final output.
- Login/recovery/logout/session expiry.
- Workspace switch without data/cache leakage.
- Catalog source generation.
- PDF upload → processing → generation.
- Double submit/network uncertainty → one job/charge.
- Job retry/partial/terminal/reload.
- Quick/detail review, autosave conflict, targeted regeneration.
- Finalize immutable version.
- Canonical PDF print/download.
- Share create/open/expire/revoke/no key leakage.
- History/duplicate/bank/template run.
- School invitation/activation/suspend/seat/usage.
- Superadmin scoped operation/audit.
- Deletion and backup tombstone behavior.

## Supported browser/device baseline

Owner sets versions before pilot based on audience telemetry. Initial test candidates:

- current and previous stable Chrome/Edge desktop;
- current stable Firefox desktop for core web flow;
- current Safari desktop/iOS for public/app critical flow;
- Android Chrome at 390-ish viewport;
- 320 CSS px reflow/200% zoom accessibility case.

PDF generation browser is pinned separately and does not imply frontend support matrix.

## Performance/resilience scenarios

- low-end/slow network landing and generate form;
- 20/50 question review/render;
- concurrent submit at quota boundary;
- queue backlog/provider rate limit;
- worker crash at every durable boundary;
- DB/storage temporary unavailable;
- graceful shutdown/deploy during job;
- expired upload/download/share token;
- restoration from backup and reconciliation.

Set numeric pass thresholds from baseline/owner decision; do not invent public SLA.

## Security cases

- tenant ID substitution across every resource type;
- list/count/search/cache leakage;
- CSRF/origin/session fixation/revocation;
- login/recovery/invite enumeration and replay;
- malicious PDF/magic bytes/zip-bomb-like limits/encrypted file;
- prompt injection/source instruction;
- XSS/rich text/PDF template/network egress;
- signed URL/token referrer/log leak;
- webhook replay/signature/order;
- quota/job duplicate;
- superadmin privilege escalation/audit bypass;
- secret scan and log-content assertions.

## Accessibility

- keyboard-only critical journeys;
- semantic headings/landmarks/forms/errors/live regions;
- focus route/dialog/drawer/regeneration;
- contrast, non-color status, reduced motion;
- 200% zoom and long copy;
- screen reader smoke for auth/generate/review/output;
- accessible web-share alternative while PDF tagging is unverified.

## Release evidence bundle

- commit/artifact/contract/migration versions;
- exact commands and environment;
- automated reports and failure count;
- 390/768/1280 screenshots for changed surfaces;
- AI eval dataset/report version;
- PDF golden report/page count;
- tenant/security checklist;
- backup/restore and rollback result where release requires;
- known limitations and owner sign-off.

