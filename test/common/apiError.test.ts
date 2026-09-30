/**
 * Regression tests for the shorthand -> StableErrorCode mapping in
 * `src/common/errors/apiError.ts`.
 *
 * Background: `throwApiError('validation_error', ...)` (BUG-02, /v1/templates)
 * and `throwApiError('password_policy', ...)` (BUG-20b / t_c3e6a292,
 * POST /v1/auth/register) both fell through to the default INTERNAL_ERROR, so
 * plain bad input answered `500 { retryable: true }`. Clients could not tell
 * "input salah" from "server rusak" and retried a request that can never
 * succeed.
 *
 * The last test is the guard that makes this class of bug impossible to
 * reintroduce silently: it scans `src/` and fails when a shorthand is used
 * without a mapping.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SHORTHAND_ERROR_CODE_MAP, throwApiError } from '../../src/common/errors/apiError.js';
import { defaultStatusFor } from '../../src/common/errors/envelope.js';

const SRC_DIR = new URL('../../src', import.meta.url).pathname;

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

/** Every string literal passed as the first argument of `throwApiError(...)`. */
function collectShorthandCodes(): Map<string, string[]> {
  const pattern = /throwApiError\(\s*'([^']+)'/g;
  const found = new Map<string, string[]>();
  for (const file of collectSourceFiles(SRC_DIR)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) {
      const code = match[1]!;
      const where = found.get(code) ?? [];
      where.push(file.replace(SRC_DIR, 'src'));
      found.set(code, where);
    }
  }
  return found;
}

function catchApiError(code: string) {
  try {
    throwApiError(code, 'pesan uji');
  } catch (error) {
    return error as { code: string; status: number; retryable: boolean };
  }
  throw new Error(`throwApiError('${code}') did not throw`);
}

describe('throwApiError shorthand mapping', () => {
  it('maps password_policy to VALIDATION_FAILED / 400 / not retryable', () => {
    const err = catchApiError('password_policy');
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.status).toBe(400);
    expect(err.retryable).toBe(false);
  });

  it('maps validation_error to VALIDATION_FAILED / 400 / not retryable', () => {
    const err = catchApiError('validation_error');
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.status).toBe(400);
    expect(err.retryable).toBe(false);
  });

  it('maps conflict to STATE_CONFLICT / 409 / not retryable', () => {
    const err = catchApiError('conflict');
    expect(err.code).toBe('STATE_CONFLICT');
    expect(err.status).toBe(409);
    expect(err.retryable).toBe(false);
  });

  it('maps not_found to RESOURCE_NOT_FOUND / 404', () => {
    const err = catchApiError('not_found');
    expect(err.code).toBe('RESOURCE_NOT_FOUND');
    expect(err.status).toBe(404);
    expect(err.retryable).toBe(false);
  });

  it('keeps the pre-existing shorthands unchanged', () => {
    expect(catchApiError('forbidden').code).toBe('PERMISSION_DENIED');
    expect(catchApiError('missing_token').code).toBe('AUTH_REQUIRED');
    expect(catchApiError('email_exists').code).toBe('STATE_CONFLICT');
    expect(catchApiError('rate_limited').code).toBe('RATE_LIMITED');
  });

  it('honours a status override without changing the stable code', () => {
    try {
      throwApiError('validation_error', 'pesan uji', 422);
    } catch (error) {
      const overridden = error as { code: string; status: number };
      expect(overridden.code).toBe('VALIDATION_FAILED');
      expect(overridden.status).toBe(422);
    }
  });

  it('still falls back to INTERNAL_ERROR for genuinely unknown shorthands', () => {
    const err = catchApiError('totally_unknown_shorthand');
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.status).toBe(500);
  });

  it('maps every shorthand used in src/, so no endpoint degrades to a 500 by accident', () => {
    const used = collectShorthandCodes();
    expect(used.size).toBeGreaterThan(20);

    const unmapped = [...used.entries()]
      .filter(([code]) => !(code in SHORTHAND_ERROR_CODE_MAP))
      .map(([code, files]) => `${code} (used in ${[...new Set(files)].join(', ')})`);

    expect(unmapped).toEqual([]);
  });

  it('never maps a client-error shorthand to a retryable 5xx code', () => {
    const clientErrorShorthands = [
      'validation_error',
      'missing_fields',
      'invalid_input',
      'password_policy',
      'conflict',
      'not_found',
      'forbidden',
    ];
    for (const code of clientErrorShorthands) {
      const err = catchApiError(code);
      expect(err.status, `${code} must not be a 5xx`).toBeLessThan(500);
      expect(err.retryable, `${code} must not be retryable`).toBe(false);
      expect(defaultStatusFor(err.code as never)).toBe(err.status);
    }
  });
});
