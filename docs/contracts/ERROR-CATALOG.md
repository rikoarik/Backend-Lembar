# Stable Error Catalog

## Envelope

```json
{
  "error": {
    "code": "SOURCE_NOT_READY",
    "message": "Sumber materi masih diproses.",
    "requestId": "req_opaque",
    "retryable": true,
    "fieldErrors": {}
  }
}
```

`message` is safe Indonesian default; clients may map code to richer copy. Raw exception,
provider detail, source/question text, secret, token, storage key, and stack trace are forbidden.

## HTTP mapping

| Code | HTTP | Retry | User action |
| --- | ---: | --- | --- |
| `VALIDATION_FAILED` | 400 | no | correct fields |
| `MALFORMED_REQUEST` | 400 | no | refresh/client bug |
| `AUTH_REQUIRED` | 401 | after login | login |
| `SESSION_EXPIRED` | 401 | after login | login and resume |
| `INVALID_CREDENTIALS` | 401 | no | retry/recover; enumeration-safe |
| `CSRF_FAILED` | 403 | after refresh | refresh/login |
| `ORIGIN_NOT_ALLOWED` | 403 | no | support/config |
| `PERMISSION_DENIED` | 403 | no | switch workspace/contact admin |
| `WORKSPACE_ACCESS_DENIED` | 404/403 | no | switch workspace |
| `RESOURCE_NOT_FOUND` | 404 | no | back/list |
| `METHOD_NOT_ALLOWED` | 405 | no | client bug |
| `STATE_CONFLICT` | 409 | after reload | reload/resolve |
| `VERSION_CONFLICT` | 409 | after compare | preserve/copy/reload |
| `IDEMPOTENCY_KEY_REUSED` | 409 | no | new key for new request |
| `DUPLICATE_RESOURCE` | 409 | no | use existing/change input |
| `ENTITLEMENT_REQUIRED` | 402/403 | no | plan/admin |
| `QUOTA_EXHAUSTED` | 429/403 | later | usage/plan |
| `RATE_LIMITED` | 429 | yes | retry after |
| `SERVICE_UNAVAILABLE` | 503 | yes | retry later |
| `INTERNAL_ERROR` | 500 | maybe | retry/support with request ID |

Choose 402 vs 403/429 consistently in executable contract; do not vary per endpoint casually.

## Identity/workspace

| Code | Meaning |
| --- | --- |
| `REGISTRATION_UNAVAILABLE` | registration disabled/not eligible |
| `VERIFICATION_REQUIRED` | account action requires verification |
| `RECOVERY_TOKEN_INVALID` | invalid/expired/used, generic response |
| `INVITATION_INVALID` | expired/revoked/used or wrong context safely |
| `MEMBERSHIP_SUSPENDED` | active account but membership unavailable |
| `LAST_ADMIN_REQUIRED` | cannot remove/demote final school admin |
| `WORKSPACE_SWITCH_CONFLICT` | unsaved/state/session issue prevents switch |

## Catalog/source

| Code | Retry | Meaning/action |
| --- | --- | --- |
| `CATALOG_COMBINATION_UNAVAILABLE` | no | class/subject/material not ready |
| `CATALOG_VERSION_ARCHIVED` | no | choose active version |
| `SOURCE_UPLOAD_EXPIRED` | yes | create new upload intent |
| `SOURCE_FILE_INVALID` | no | wrong magic/type/corrupt |
| `SOURCE_FILE_TOO_LARGE` | no | choose within limit |
| `SOURCE_ENCRYPTED` | no | upload unlocked PDF |
| `SOURCE_SCAN_REJECTED` | no | file unsafe |
| `SOURCE_PROCESSING` | yes | wait |
| `SOURCE_NOT_READY` | yes/action | wait/retry source |
| `SOURCE_TEXT_INSUFFICIENT` | no/action | different PDF/source |
| `SOURCE_PROCESSING_FAILED` | depends | retry or replace |
| `SOURCE_DELETED` | no | choose source |

## Assessment/generation

| Code | Retry | Meaning/action |
| --- | --- | --- |
| `ASSESSMENT_NOT_EDITABLE` | no | duplicate/new draft |
| `GENERATION_ALREADY_RUNNING` | no | open existing job |
| `GENERATION_FAILED_RETRYABLE` | yes | retry same config |
| `GENERATION_SOURCE_UNSUPPORTED` | no/action | change source/config |
| `GENERATION_QUALITY_INSUFFICIENT` | action | review partial/change input |
| `QUESTION_INVALID` | no | field validation |
| `QUESTION_REGENERATION_RUNNING` | no | wait/open job |
| `FINALIZATION_BLOCKED` | no/action | resolve listed review issues |
| `FINAL_VERSION_IMMUTABLE` | no | create new draft version |
| `JOB_CANNOT_CANCEL` | no | wait terminal |
| `JOB_RETRY_NOT_ALLOWED` | no | edit input/support |

## Output/share

| Code | Retry | Meaning/action |
| --- | --- | --- |
| `EXPORT_REQUIRES_FINAL` | no | finalize first |
| `EXPORT_RENDER_FAILED` | yes/support | retry/request ID |
| `ARTIFACT_NOT_READY` | yes | wait |
| `ARTIFACT_EXPIRED` | yes | regenerate artifact |
| `SHARE_UNAVAILABLE` | no | generic expired/revoked/not found |
| `SHARE_SCOPE_INVALID` | no | choose allowed package |

## Billing/operations

| Code | Meaning/action |
| --- | --- |
| `SUBSCRIPTION_PAST_DUE` | billing contact action |
| `CHECKOUT_UNAVAILABLE` | retry/support |
| `WEBHOOK_INVALID` | provider request rejected; never user-facing detail |
| `SEAT_LIMIT_REACHED` | admin plan/member action |
| `FEATURE_DISABLED` | capability not released/temporarily disabled |
| `MAINTENANCE_MODE` | retry later/read-only behavior |

## Error governance

- Codes are uppercase snake case and stable.
- Adding code updates OpenAPI, client mapping, UI state/copy, tests, and this catalog.
- Never repurpose a code with new meaning.
- Retryable is determined server-side and consistent with side-effect/idempotency rules.
- 5xx/unknown user-facing copy always includes request ID, not internal detail.
- Metrics use code/operation only, not error message/free text.

