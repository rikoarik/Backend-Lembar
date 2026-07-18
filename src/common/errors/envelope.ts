// Stable error envelope and codes subset shared across runtime, OpenAPI, and tests.
// See docs/contracts/CROSS-REPO-CONTRACT.md and docs/contracts/ERROR-CATALOG.md.
// ponytail: full catalog (29+ codes) lives in ERROR-CATALOG.md; widen enum there and
// here together when an endpoint needs a code outside this B0-03 baseline subset.

export const STABLE_ERROR_CODES = [
  'AUTH_REQUIRED',
  'PERMISSION_DENIED',
  'VALIDATION_FAILED',
  'RESOURCE_NOT_FOUND',
  'STATE_CONFLICT',
  'INTERNAL_ERROR',
  'WORKSPACE_ACCESS_DENIED',
  'RATE_LIMITED',
] as const;

export type StableErrorCode = (typeof STABLE_ERROR_CODES)[number];

export type FieldErrors = Readonly<Record<string, readonly string[]>>;

export interface ErrorBody {
  code: StableErrorCode;
  message: string;
  requestId: string;
  retryable: boolean;
  fieldErrors?: FieldErrors;
}

export interface ErrorEnvelope {
  error: ErrorBody;
}

export interface ApiErrorInit {
  code: StableErrorCode;
  message: string;
  requestId: string;
  status?: number;
  retryable?: boolean;
  fieldErrors?: FieldErrors;
}

const HTTP_BY_CODE: Readonly<Record<StableErrorCode, number>> = {
  AUTH_REQUIRED: 401,
  PERMISSION_DENIED: 403,
  VALIDATION_FAILED: 400,
  RESOURCE_NOT_FOUND: 404,
  STATE_CONFLICT: 409,
  INTERNAL_ERROR: 500,
  WORKSPACE_ACCESS_DENIED: 404,
  RATE_LIMITED: 429,
};

export function isStableErrorCode(value: string): value is StableErrorCode {
  return (STABLE_ERROR_CODES as readonly string[]).includes(value);
}

export function defaultStatusFor(code: StableErrorCode): number {
  return HTTP_BY_CODE[code];
}

export function buildErrorEnvelope(init: {
  code: StableErrorCode;
  message: string;
  requestId: string;
  retryable?: boolean;
  fieldErrors?: FieldErrors;
}): ErrorEnvelope {
  const retryable = init.retryable ?? false;
  const body: ErrorBody = {
    code: init.code,
    message: init.message,
    requestId: init.requestId,
    retryable,
  };
  const envelope: ErrorEnvelope = { error: body };
  if (init.fieldErrors !== undefined) {
    return { error: { ...body, fieldErrors: init.fieldErrors } };
  }
  return envelope;
}

export class ApiError extends Error {
  public readonly code: StableErrorCode;
  public readonly status: number;
  public readonly retryable: boolean;
  public readonly requestId: string;
  public readonly fieldErrors: FieldErrors | undefined;
  public readonly expose: boolean;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status ?? defaultStatusFor(init.code);
    this.retryable = init.retryable ?? false;
    this.requestId = init.requestId;
    this.fieldErrors = init.fieldErrors;
    this.expose = true;
  }

  toEnvelope(): ErrorEnvelope {
    return buildErrorEnvelope({
      code: this.code,
      message: this.message,
      requestId: this.requestId,
      retryable: this.retryable,
      ...(this.fieldErrors === undefined ? {} : { fieldErrors: this.fieldErrors }),
    });
  }
}
