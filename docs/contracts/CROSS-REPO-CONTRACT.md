# Cross-Repository Contract

## Ownership

| Concern                                      | Owner                                        | Consumer                        |
| -------------------------------------------- | -------------------------------------------- | ------------------------------- |
| Product requirements/roles                   | Product owner                                | FE + BE                         |
| Visual system and interaction                | Frontend                                     | Product + BE for constraints    |
| REST paths, payloads, errors, auth semantics | Backend                                      | Frontend + future mobile        |
| OpenAPI source                               | Backend                                      | Frontend CI/codegen             |
| Marketing content schema/public projection  | Backend                                      | Frontend renderer/runtime guard |
| Marketing layout/component registry          | Frontend                                     | Backend publish compatibility   |
| Database schema/migrations                   | Backend                                      | Backend only                    |
| AI prompt/model/provider                     | Backend                                      | Frontend sees neutral job state |
| Analytics event names/properties             | Product contract; implemented per repo       | Product/data                    |
| Print document data contract                 | Backend domain + FE print template agreement | FE + worker                     |

## Contract workflow

1. Backend maintains OpenAPI as code/generated artifact.
2. CI validates OpenAPI and detects breaking changes.
3. A versioned artifact is published from backend commit/tag.
4. Frontend pins artifact version and generates TypeScript client/types.
5. Frontend does not handwrite duplicate API response interfaces.
6. Breaking changes require a cross-repo change proposal, migration window, and owner approval.
7. Backend supports old contract until the pinned frontend release has migrated.

## Versioning

- Base path: `/v1`.
- Additive optional fields are normally non-breaking.
- Removing/renaming fields, narrowing enums, changing types/meaning, or changing permission
  semantics is breaking.
- New required request fields require default/migration or a new endpoint/version.
- Job/status enums use an `unknown` UI fallback to survive additive backend values.

## Authentication contract

- Browser session is controlled by backend using secure, HttpOnly cookie.
- Frontend never reads the session token directly.
- State-changing browser requests include CSRF protection defined by backend.
- CORS is allowlisted; wildcard origin with credentials is forbidden.
- Frontend calls `/v1/me` to resolve account, active workspace options, and entitlements.
- `401` means no/expired session; `403` means authenticated but not permitted.
- Future mobile authentication is a separate ADR; do not weaken browser session design now.

## Workspace contract

- Every tenant-bound request resolves a workspace explicitly through route/header/body as
  specified by OpenAPI.
- Baseline header: `X-Workspace-Id` for tenant-bound `/v1` endpoints.
- Backend verifies membership; header possession alone grants nothing.
- Frontend clears/rekeys tenant cache when workspace changes.

## Marketing CMS contract

- Backend owns authoring state, version, publish pointer, authorization, audit, and executable
  OpenAPI schemas.
- Frontend owns route layout, block registry, visual behavior, seed fallback, and runtime
  compatibility handling.
- Public cache key is locale + slug + published content version; it is never workspace-bound.
- Preview is authenticated/no-store and uses the same renderer without entering public cache.
- Backend never sends arbitrary component/module names, HTML, CSS, or JavaScript.
- Frontend ignores/falls back section-locally for an unknown block and emits sanitized
  telemetry; it must not blank the whole page.
- Additive optional fields are compatible. New required field, enum removal, or block contract
  change requires coordinated version bump and consumer evidence.
- MVP propagation: Cache-Control/ETag plus frontend revalidation, visible within 60 seconds.
- CMS does not introduce queue/Redis or a third deployment unit.
- Error `WORKSPACE_ACCESS_DENIED` must not disclose workspace data.

## Idempotency

Create/generation/export actions that can be retried accept `Idempotency-Key`.

- Key scoped to account/workspace + operation.
- Same key + same payload returns prior operation.
- Same key + different payload returns `409 IDEMPOTENCY_CONFLICT`.
- Frontend persists key while a submission is uncertain and does not generate a new key on
  blind retry.

## Error envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Periksa kembali data yang diisi.",
    "fieldErrors": { "materials": ["Pilih minimal satu materi."] },
    "requestId": "req_...",
    "retryable": false
  }
}
```

Rules:

- `code` stabil dan machine-readable.
- `message` aman untuk pengguna; tidak berisi stack trace/provider detail.
- `fieldErrors` opsional.
- `requestId` dapat diberikan ke support.
- `retryable` membantu UI memilih retry vs edit input.

## Pagination

Cursor-based untuk history/bank/jobs:

```json
{
  "data": [],
  "page": { "nextCursor": null, "hasMore": false }
}
```

Sort order deterministik harus termasuk unique tie-breaker.

## Async jobs

Public job status:

- `queued`
- `preparing`
- `generating`
- `validating`
- `rendering`
- `completed`
- `partially_failed`
- `failed`
- `cancelled`

Frontend tidak menerima nama provider/model, prompt, raw exception, atau secret. Progress tidak
boleh dipalsukan sebagai persentase presisi jika backend hanya mengetahui stage.

## Date, locale, and IDs

- JSON date/time: ISO 8601 UTC.
- Display timezone/locale di frontend.
- Uang: integer minor unit + ISO currency.
- ID opaque string; frontend tidak mengandalkan format.
- Academic year adalah data, bukan konstanta UI.

## File upload

- Backend membuat upload intent.
- Frontend upload sesuai batas dan headers yang diberikan.
- Completion/processing diverifikasi backend.
- UI tidak menganggap upload ready sebelum status extraction `ready`.
- Signed URL tidak dicatat di analytics/log client.

## Analytics privacy

Tidak boleh mengirim:

- teks soal/opsi/pembahasan;
- isi/fingerprint bermakna dari materi;
- email/nama lengkap sebagai event property;
- share token, signed URL, session, atau API key;
- prompt guru mentah.

Gunakan opaque IDs, category, counts, durations, dan status.

## Cross-repo integration gate

Sebuah feature end-to-end diterima hanya jika:

- backend contract test pass;
- frontend generated client up to date;
- frontend handles success, empty, validation, auth, permission, conflict, and retry states;
- staging smoke pass dengan versi FE/BE yang dicatat;
- no contract drift di CI;
- product owner menerima outcome.
