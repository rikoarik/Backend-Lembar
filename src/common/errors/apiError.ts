// Helper untuk throw ApiError dengan shorthand syntax
// Wrapper untuk ApiError yang expects ApiErrorInit object

import { ApiError, type StableErrorCode } from './envelope.js';

/**
 * Throw ApiError with simplified syntax
 * Maps common error codes to appropriate StableErrorCode
 */
export function throwApiError(
  code: string,
  message: string,
  statusOverride?: number,
): never {
  // Map common error codes to StableErrorCode
  const codeMap: Record<string, StableErrorCode> = {
    missing_fields: 'VALIDATION_FAILED',
    invalid_email: 'VALIDATION_FAILED',
    password_too_short: 'VALIDATION_FAILED',
    invalid_name: 'VALIDATION_FAILED',
    invalid_roles: 'VALIDATION_FAILED',
    email_exists: 'STATE_CONFLICT',
    workspace_creation_failed: 'INTERNAL_ERROR',
    user_creation_failed: 'INTERNAL_ERROR',
    missing_token: 'AUTH_REQUIRED',
    invalid_auth_format: 'AUTH_REQUIRED',
    invalid_token: 'AUTH_REQUIRED',
    invalid_credentials: 'AUTH_REQUIRED',
    user_not_found: 'RESOURCE_NOT_FOUND',
    unauthorized: 'AUTH_REQUIRED',
    forbidden: 'PERMISSION_DENIED',
    invalid_input: 'VALIDATION_FAILED',
  };

  const stableCode = codeMap[code] || 'INTERNAL_ERROR';

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
