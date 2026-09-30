// Helper untuk throw ApiError dengan shorthand syntax
// Wrapper untuk ApiError yang expects ApiErrorInit object

import { ApiError, type StableErrorCode } from './envelope.js';

/**
 * Shorthand code -> StableErrorCode map.
 *
 * Setiap shorthand yang dioper ke `throwApiError()` HARUS punya entri di sini.
 * Shorthand yang tidak terpetakan diam-diam jatuh ke `INTERNAL_ERROR`
 * (HTTP 500 + `retryable: true`), yang memberitahu klien "server rusak" padahal
 * inputnya yang salah — dan mengundang retry yang tidak akan pernah berhasil.
 *
 * Regresi ini sudah dua kali terjadi: BUG-02 (`/v1/templates`) dan
 * BUG-20b / t_c3e6a292 (`POST /v1/auth/register` password lemah). Karena itu
 * test `test/common/apiError.test.ts` memindai seluruh `src/` dan gagal bila ada
 * shorthand yang dipakai tanpa mapping.
 */
export const SHORTHAND_ERROR_CODE_MAP: Readonly<Record<string, StableErrorCode>> = {
  // 400 — input salah, tidak boleh di-retry apa adanya
  missing_fields: 'VALIDATION_FAILED',
  validation_error: 'VALIDATION_FAILED',
  invalid_input: 'VALIDATION_FAILED',
  invalid_email: 'VALIDATION_FAILED',
  invalid_username: 'VALIDATION_FAILED',
  invalid_phone: 'VALIDATION_FAILED',
  invalid_name: 'VALIDATION_FAILED',
  invalid_roles: 'VALIDATION_FAILED',
  password_too_short: 'VALIDATION_FAILED',
  password_policy: 'VALIDATION_FAILED',
  captcha_required: 'VALIDATION_FAILED',
  captcha_invalid: 'VALIDATION_FAILED',

  // 409 — bentrok state (nama/email/username/telepon sudah dipakai)
  email_exists: 'STATE_CONFLICT',
  username_exists: 'STATE_CONFLICT',
  phone_exists: 'STATE_CONFLICT',
  conflict: 'STATE_CONFLICT',

  // 404 — resource tidak ada
  user_not_found: 'RESOURCE_NOT_FOUND',
  not_found: 'RESOURCE_NOT_FOUND',

  // 401 — autentikasi
  missing_token: 'AUTH_REQUIRED',
  invalid_auth_format: 'AUTH_REQUIRED',
  invalid_token: 'AUTH_REQUIRED',
  invalid_credentials: 'AUTH_REQUIRED',
  account_suspended: 'AUTH_REQUIRED',
  unauthorized: 'AUTH_REQUIRED',

  // 403 — otorisasi
  forbidden: 'PERMISSION_DENIED',

  // 429 — rate limit
  rate_limited: 'RATE_LIMITED',

  // 500 — kegagalan server (retryable)
  workspace_creation_failed: 'INTERNAL_ERROR',
  user_creation_failed: 'INTERNAL_ERROR',
};

/**
 * Throw ApiError with simplified syntax
 * Maps common error codes to appropriate StableErrorCode
 */
export function throwApiError(code: string, message: string, statusOverride?: number): never {
  const stableCode = SHORTHAND_ERROR_CODE_MAP[code] || 'INTERNAL_ERROR';

  const init: { code: StableErrorCode; message: string; requestId: string; status?: number } = {
    code: stableCode,
    message,
    requestId: 'pending', // Will be set by error handler
  };

  if (statusOverride !== undefined) {
    init.status = statusOverride;
  }

  throw new ApiError(init);
}
