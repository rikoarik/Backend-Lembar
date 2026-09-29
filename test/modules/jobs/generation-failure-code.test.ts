/**
 * Root-cause propagation for failed generation jobs.
 *
 * Regression guard for audit finding #2: a job that failed to produce any
 * question used to reach the client as {code:'UNKNOWN'}. The handler now
 * derives a stable code from the per-question failure reasons and keeps the
 * provider's own message.
 */
import { describe, expect, test } from 'vitest';

import {
  failureCodeFor,
  failureMessageFor,
} from '../../../src/infrastructure/queue/handlers/AssessmentGenerationHandler.js';

describe('assessment generation failure code', () => {
  test('maps a uniform provider failure to PROVIDER_ERROR', () => {
    expect(
      failureCodeFor([
        { reason: 'provider_error', message: 'HTTP 404: No active credentials' },
        { reason: 'provider_error', message: 'HTTP 404: No active credentials' },
      ]),
    ).toBe('PROVIDER_ERROR');
  });

  test('maps the other single reasons to their stable codes', () => {
    expect(failureCodeFor([{ reason: 'schema_repair_exhausted', message: 'x' }])).toBe(
      'SCHEMA_REPAIR_EXHAUSTED',
    );
    expect(failureCodeFor([{ reason: 'insufficient_source', message: 'x' }])).toBe(
      'SOURCE_INSUFFICIENT',
    );
    expect(failureCodeFor([{ reason: 'something_new', message: 'x' }])).toBe('GENERATION_ERROR');
  });

  test('maps mixed reasons to GENERATION_FAILED and empty input to GENERATION_ERROR', () => {
    expect(
      failureCodeFor([
        { reason: 'provider_error', message: 'a' },
        { reason: 'insufficient_source', message: 'b' },
      ]),
    ).toBe('GENERATION_FAILED');
    expect(failureCodeFor([])).toBe('GENERATION_ERROR');
  });

  test('never returns the generic UNKNOWN the worker falls back to', () => {
    for (const failures of [
      [],
      [{ reason: 'provider_error', message: 'a' }],
      [
        { reason: 'provider_error', message: 'a' },
        { reason: 'insufficient_source', message: 'b' },
      ],
    ]) {
      expect(failureCodeFor(failures)).not.toBe('UNKNOWN');
    }
  });
});

describe('assessment generation failure message', () => {
  test("preserves the provider's own message", () => {
    expect(
      failureMessageFor([
        { reason: 'provider_error', message: 'AI provider error at sequence 0: timeout' },
      ]),
    ).toBe('AI provider error at sequence 0: timeout');
  });

  test('falls back to the reason when the message is empty, and is never empty', () => {
    expect(failureMessageFor([{ reason: 'provider_error', message: '' }])).toContain(
      'provider_error',
    );
    expect(failureMessageFor([]).length).toBeGreaterThan(0);
  });
});
