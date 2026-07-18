# Security, Privacy & Operations

## Threat priorities

1. Cross-tenant data access.
2. Exam/source leakage through share/storage/logs.
3. Account takeover and admin abuse.
4. Malicious upload or prompt injection.
5. SSRF if URL ingestion is introduced.
6. Quota/payment replay or race.
7. Provider/secret exposure.
8. Destructive operational mistakes without audit/backup.

## Identity/session

- Auth implementation selected through D-002 spike; do not build crypto/session primitives ad hoc.
- Browser session uses Secure, HttpOnly, appropriate SameSite cookie and rotation/revocation.
- Passwords use reputable adaptive hashing via auth library.
- Recovery/invitation token random, single-use, hashed at rest, expiring.
- State-changing browser requests validate CSRF and origin.
- Rate-limit login, recovery, invite, generate, export, and share access appropriately.

## Authorization and tenancy

- Every request derives account and validates active workspace membership.
- Repository/application method requires workspace context.
- Superadmin path separate and audited; no magic tenant bypass in normal repository.
- IDOR tests attempt known foreign IDs across every tenant resource.
- Cache, object key, queue job, analytics, and trace all retain tenant context safely.
- RLS is defense-in-depth, not the only control.
- Marketing CMS ops are platform-scoped superadmin commands, not tenant commands; they never
  trust X-Workspace-Id as an authorization grant.

## Marketing CMS security

- Public endpoints return only immutable published projections and hide draft existence.
- Ops mutations require superadmin session, CSRF/origin checks, revision precondition, and
  audit. Publish/restore may require step-up according to auth policy.
- Preview is authenticated, short-lived/no-store, and cannot be converted into a public link.
- Reject arbitrary HTML/CSS/JavaScript, iframe, event-handler attributes, unsafe URL schemes,
  unknown blocks, oversized documents, and media not in ready state.
- Content audit stores safe field summaries/hashes, not entire content bodies or secrets.
- Decision-gated values such as price cannot publish before the decision register allows them.

## Upload/source security

- Allowlist PDF only for MVP; validate magic/MIME and parser behavior.
- Size/page limits and decompression/time/memory limits.
- Malware scan and quarantine before extraction.
- Object storage private; object keys opaque.
- Parser runs isolated/limited; generated HTML is escaped.
- Document content cannot instruct system/prompt policy.
- Metadata stripped/sanitized where appropriate.
- Retention, deletion, backup expiry, and legal hold behavior documented.

## URL ingestion if approved later

- Only HTTP(S), DNS/IP resolution checks, block loopback/private/link-local/metadata ranges.
- Re-check every redirect and resolution.
- Response size/type/time limits.
- Egress allowlist/proxy where possible.
- Store snapshot, access time, final URL, and provenance.

## AI/provider privacy

- API key only in worker runtime.
- Minimize data sent; exclude account identity and student data.
- Configure provider storage/retention intentionally and document data processing.
- Logs contain provider request ID/usage/status, not prompt/source/output by default.
- Support/debug content access is explicit, time-limited, reasoned, and audited.

## Share/download

- Share tokens high entropy and preferably hash-at-rest.
- Revocable, optional expiry, rate limit, no-index/referrer controls.
- Signed artifact URLs short-lived and never analytics properties.
- Authorization happens before signing.
- Answer key/pembahasan exposure requires explicit option and clear UI.

## Secrets/config

- Separate secrets per environment and process.
- No secret in repo, frontend, Docker image layer, test fixture, or logs.
- Rotation runbook for auth, storage, DB, queue, selected AI provider, mail, payment.
- Secret scan is defense, not permission to use fake production-like keys in fixtures.

## Database/backup

- TLS where applicable, least privilege, migration role separate from runtime.
- Automated backups and point-in-time recovery if supported.
- Restore drill before pilot and periodically thereafter.
- Destructive migration uses expand/migrate/contract and rollback plan.
- No production copy in dev/preview.

## Audit events

At minimum:

- sensitive login/session events;
- membership/role/invite changes;
- finalization and share create/revoke;
- quota adjustment/refund;
- catalog/prompt/model publish;
- marketing content save/publish/unpublish/restore and preview-token issuance;
- support data access;
- feature flag and incident operations.

Audit is append-oriented and protected from normal user editing.

## Observability

- Structured JSON logs with service/process/env/request/job/workspace opaque IDs.
- Trace API request → transaction/outbox → worker → provider → artifact.
- Metrics: latency/error, queue age, job success/retry, provider error/usage/cost, PDF duration,
  DB pool, auth failures, share abuse.
- Alerts have owner, threshold, and runbook.
- Redaction tests cover known secret/content fields.

## Incident levels

- SEV-1: confirmed cross-tenant/secret breach, widespread data loss, auth compromise.
- SEV-2: major outage, queue stuck, export/generation broadly unavailable.
- SEV-3: limited degradation or isolated failed feature.

Immediate actions prioritize containment, evidence preservation, owner/security notification,
safe rollback, and communication. Legal notification requirements require qualified review.

## Compliance/legal gates

Before paid/public launch, obtain review for Indonesian privacy law, processor/vendor terms,
retention/deletion, education content, copyright/licensing, child-related data, and policies.
Technical docs do not claim legal compliance.
