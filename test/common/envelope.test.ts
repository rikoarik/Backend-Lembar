import { describe, expect, it } from 'vitest';

import {
  ApiError,
  buildErrorEnvelope,
  isStableErrorCode,
  STABLE_ERROR_CODES,
  type FieldErrors,
} from '../../src/common/errors/envelope.js';

describe('error envelope', () => {
  it('exposes the documented stable codes subset', () => {
    expect(STABLE_ERROR_CODES).toEqual([
      'AUTH_REQUIRED',
      'PERMISSION_DENIED',
      'VALIDATION_FAILED',
      'RESOURCE_NOT_FOUND',
      'STATE_CONFLICT',
      'INTERNAL_ERROR',
      'WORKSPACE_ACCESS_DENIED',
      'RATE_LIMITED',
      'IDEMPOTENCY_KEY_REUSED',
    ]);
  });

  it('accepts only documented codes', () => {
    for (const code of STABLE_ERROR_CODES) {
      expect(isStableErrorCode(code)).toBe(true);
    }
    expect(isStableErrorCode('NOT_A_CODE')).toBe(false);
    expect(isStableErrorCode('validation_failed')).toBe(false);
  });

  it('builds a redacted envelope with requestId and defaults', () => {
    const env = buildErrorEnvelope({
      code: 'INTERNAL_ERROR',
      message: 'Terjadi kesalahan pada server.',
      requestId: 'req_abc',
    });
    expect(env).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Terjadi kesalahan pada server.',
        requestId: 'req_abc',
        retryable: false,
      },
    });
  });

  it('omits fieldErrors when none provided and includes when present', () => {
    const noFields = buildErrorEnvelope({
      code: 'VALIDATION_FAILED',
      message: 'Data tidak valid.',
      requestId: 'req_x',
      retryable: false,
    });
    expect(Object.hasOwn(noFields.error, 'fieldErrors')).toBe(false);

    const fieldErrors: FieldErrors = { materials: ['Pilih minimal satu materi.'] };
    const withFields = buildErrorEnvelope({
      code: 'VALIDATION_FAILED',
      message: 'Data tidak valid.',
      requestId: 'req_y',
      fieldErrors,
    });
    expect(withFields.error.fieldErrors).toEqual(fieldErrors);
  });

  it('never leaks stack, secret, or token substrings', () => {
    const env = buildErrorEnvelope({
      code: 'INTERNAL_ERROR',
      message: 'Internal failure',
      requestId: 'req_z',
    });
    const serialized = JSON.stringify(env).toLowerCase();
    for (const forbidden of ['stack', 'password', 'token', 'secret', 'bearer', 'apikey']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('ApiError', () => {
  it('captures code, status, retryable, message, and fieldErrors', () => {
    const fieldErrors: FieldErrors = { name: ['Wajib diisi.'] };
    const err = new ApiError({
      code: 'VALIDATION_FAILED',
      message: 'Data tidak valid.',
      requestId: 'req_1',
      status: 400,
      retryable: false,
      fieldErrors,
    });
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.status).toBe(400);
    expect(err.retryable).toBe(false);
    expect(err.requestId).toBe('req_1');
    expect(err.message).toBe('Data tidak valid.');
    expect(err.fieldErrors).toEqual(fieldErrors);
    expect(err.expose).toBe(true);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApiError');
  });

  it('envelopes itself with the provided requestId', () => {
    const err = new ApiError({
      code: 'RESOURCE_NOT_FOUND',
      message: 'Sumber tidak ditemukan.',
      requestId: 'req_2',
    });
    const env = err.toEnvelope();
    expect(env.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(env.error.requestId).toBe('req_2');
    expect(env.error.retryable).toBe(false);
    expect(env.error.fieldErrors).toBeUndefined();
  });
});
