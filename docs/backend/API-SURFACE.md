# API Surface and Governance

Status: planning contract. `shared/openapi-baseline.yaml` contains the executable baseline;
backend expands it task-by-task and publishes a versioned artifact consumed by frontend.

## Conventions

- Base path `/v1`; system health may live outside versioned API.
- JSON request/response with stable operation IDs.
- Session cookie for web; future mobile token path requires auth ADR.
- `X-Workspace-Id` is explicit context, not proof of access.
- Browser mutations require CSRF/origin protection selected by auth design.
- `Idempotency-Key` required for costly/non-repeatable create/finalize/export/payment operations.
- Cursor pagination; stable sort and opaque cursor.
- UTC ISO 8601 timestamps; localized display belongs to clients.
- Error envelope/codes from `shared/ERROR-CATALOG.md`.
- Unknown unauthorized resource may return safe 404 to avoid existence leaks.

## System

| Method/path | Operation | Priority |
| --- | --- | --- |
| `GET /health/live` | process liveness, no dependencies | B0 |
| `GET /health/ready` | readiness with redacted dependency state | B0/staging |
| `GET /version` | service/contract/build metadata, no secrets | B0 |

The legacy `/health` may remain during bootstrap but is normalized before external integration.

## Identity and current context

Exact auth route shape is finalized with D-002; domain outcomes must cover:

| Capability | Proposed path | Priority |
| --- | --- | --- |
| Register personal account | `POST /v1/auth/registrations` | P0 |
| Create session/login | `POST /v1/auth/sessions` | P0 |
| Revoke current session/logout | `DELETE /v1/auth/sessions/current` | P0 |
| List/revoke other sessions | `/v1/auth/sessions` | P1/security |
| Request recovery | `POST /v1/auth/recovery-requests` | P0 |
| Complete recovery | `POST /v1/auth/recovery-completions` | P0 |
| Accept school activation/invite | `POST /v1/auth/activations` | P1 |
| Read current account/workspaces | `GET /v1/me` | P0 |
| Update safe profile fields | `PATCH /v1/me` | P0 |
| Switch active workspace | `PUT /v1/me/active-workspace` | P0/P1 |

Auth responses never reveal whether an identifier exists where enumeration risk applies.

## Catalog

| Method/path | Operation | Priority |
| --- | --- | --- |
| `GET /v1/catalog/curricula` | active curriculum versions | P0 |
| `GET /v1/catalog/grades` | ready grades/phases | P0 |
| `GET /v1/catalog/subjects` | subjects by grade/curriculum | P0 |
| `GET /v1/catalog/materials` | materials by context | P0 |
| `GET /v1/catalog/outcomes` | CP/outcomes by context | P0 |
| `GET /v1/catalog/readiness` | ready/unavailable combination and reason | P0 |

Catalog response includes version/status. Archived values remain resolvable for history but are
not offered for new generation.

## Sources

| Method/path | Operation | Priority |
| --- | --- | --- |
| `GET /v1/sources` | list workspace-owned sources | P0 |
| `POST /v1/sources/upload-intents` | authorize private PDF upload | P0 |
| `POST /v1/sources/{id}/upload-complete` | verify object and enqueue processing | P0 |
| `GET /v1/sources/{id}` | status/metadata | P0 |
| `POST /v1/sources/{id}/retry` | retry allowed processing failure | P0 |
| `DELETE /v1/sources/{id}` | request deletion | P0 |

Upload intent response contains a short-lived URL that must be redacted from logs. Completion
verifies size, content type, checksum/object identity, ownership, and state.

## Assessments and review

| Method/path | Operation | Priority |
| --- | --- | --- |
| `GET /v1/assessments` | history/search/filter | P0 |
| `POST /v1/assessments` | create config/draft + generation job | P0 |
| `GET /v1/assessments/{id}` | overview/current version | P0 |
| `PATCH /v1/assessments/{id}` | editable metadata/config before generation rule | P0 |
| `POST /v1/assessments/{id}/duplicate` | duplicate to new draft | P0 |
| `POST /v1/assessments/{id}/archive` | archive | P0 |
| `GET /v1/assessments/{id}/versions` | version history | P0 |
| `GET /v1/assessments/{id}/questions` | paged/review-filtered questions | P0 |
| `PATCH /v1/assessments/{id}/questions/{questionId}` | edit with version precondition | P0 |
| `POST .../questions/{questionId}/review` | accept/flag/reject | P0 |
| `POST .../questions/{questionId}/regenerations` | create targeted regeneration job | P0 |
| `DELETE .../questions/{questionId}` | remove from draft | P0 |
| `POST /v1/assessments/{id}/finalizations` | immutable final version | P0 |

Mutations carry ETag/version or `If-Match`-equivalent field. Conflict returns current version
metadata without leaking content beyond authorization.

## Jobs

| Method/path | Operation | Priority |
| --- | --- | --- |
| `GET /v1/jobs/{id}` | neutral state/progress/failure code | P0 |
| `POST /v1/jobs/{id}/cancellations` | request cancellation if allowed | P0 |
| `POST /v1/jobs/{id}/retries` | explicit safe retry | P0 |
| `GET /v1/jobs/{id}/events` | optional SSE stream | Later/decision |

Polling with ETag/backoff is valid baseline. SSE is not required to claim near-real-time job UI.

## Output and sharing

| Method/path | Operation | Priority |
| --- | --- | --- |
| `GET /v1/assessments/{id}/artifacts` | list artifacts for authorized version | P0 |
| `POST /v1/assessments/{id}/exports` | create/reuse PDF job | P0 |
| `GET /v1/artifacts/{id}` | status/metadata | P0 |
| `POST /v1/artifacts/{id}/download-intents` | short-lived download | P0 |
| `GET /v1/assessments/{id}/share-links` | list active/revoked links | P0 |
| `POST /v1/assessments/{id}/share-links` | create controlled link | P0 |
| `PATCH /v1/share-links/{id}` | change expiry/scope if allowed | P0 |
| `DELETE /v1/share-links/{id}` | revoke | P0 |
| `GET /v1/public/shares/{token}` | read permitted public package | P0 |

Token is accepted in path only on public endpoint and must be redacted from access logs.

## Private library

| Method/path | Operation | Priority |
| --- | --- | --- |
| `GET/POST /v1/question-bank` | list/save approved question snapshots | P0 |
| `PATCH/DELETE /v1/question-bank/{id}` | organize/archive/remove | P0 |
| `GET/POST /v1/templates` | list/create generation config | P0 |
| `GET/PATCH/DELETE /v1/templates/{id}` | read/update/archive | P0 |
| `POST /v1/templates/{id}/runs` | create prefilled draft/generation request | P0 |

No public bank endpoint in MVP.

## Entitlement and billing

| Method/path | Operation | Priority |
| --- | --- | --- |
| `GET /v1/entitlements` | effective capabilities/limits | P0 |
| `GET /v1/usage` | allowance, reservations, period | P0 |
| `GET /v1/subscription` | provider-neutral state | Paid pilot |
| `POST /v1/checkout-sessions` | payment checkout | Paid pilot |
| `POST /v1/billing-portal-sessions` | manage billing | Paid pilot |
| `POST /v1/webhooks/{provider}` | verified provider webhook | Paid pilot |

Webhook endpoint is provider-specific and not consumed by frontend.

## School admin

| Method/path | Operation | Priority |
| --- | --- | --- |
| `GET/PATCH /v1/school` | active school profile/settings | P1 |
| `GET /v1/school/members` | members and activation state | P1 |
| `POST /v1/school/invitations` | create invite/one-time activation | P1 |
| `POST /v1/school/invitations/{id}/resend` | rotate/resend safely | P1 |
| `DELETE /v1/school/invitations/{id}` | revoke | P1 |
| `PATCH /v1/school/members/{id}` | role/status | P1 |
| `DELETE /v1/school/members/{id}` | revoke membership | P1 |
| `GET /v1/school/usage` | aggregate pooled usage | P1 |
| `GET /v1/school/audit` | admin-relevant audit page | P1 |

## Superadmin operations

Operations endpoints live under `/v1/ops/*`, require platform role plus step-up policy for
sensitive actions, and always audit. Include account/school/catalog/job/quality/entitlement/
feature-flag support as tasks land. They are not exposed in public client bundle unnecessarily.

Marketing CMS:

- `GET /v1/public/marketing/global`
- `GET /v1/public/marketing/pages/{slug}`
- `GET /v1/ops/marketing/pages`
- `GET /v1/ops/marketing/pages/{slug}`
- `PUT /v1/ops/marketing/pages/{slug}/draft`
- `GET /v1/ops/marketing/pages/{slug}/preview`
- `POST /v1/ops/marketing/pages/{slug}/publish`
- `POST /v1/ops/marketing/pages/{slug}/unpublish`
- `POST /v1/ops/marketing/pages/{slug}/versions/{version}/restore`

Public delivery is anonymous, published-only, ETag-enabled, and workspace-independent. Ops
endpoints are superadmin-only, use CSRF/revision checks, and return no-store previews.

## Contract completion gate

For each implemented endpoint:

- schema/examples and all relevant error responses;
- auth, role, workspace, idempotency, and rate-limit annotations;
- contract tests and generated client update;
- compatibility/breaking check;
- no secret/content in examples;
- frontend consumer acceptance where applicable.
