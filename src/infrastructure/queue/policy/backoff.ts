import { fingerprint } from '../../../common/redact.js';

export type RetryClassification = 'retryable' | 'terminal';

export interface RetryDecision {
  outcome: RetryClassification;
  retryable: boolean;
  nextDelayMs: number | null;
  nextAttemptAt: Date | null;
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
}

const RETRYABLE_CODES = new Set(['PROVIDER_TIMEOUT', 'RATE_LIMITED', 'TRANSIENT_ERROR']);
const TERMINAL_CODES = new Set([
  'UNSUPPORTED_SOURCE',
  'INVALID_STATE',
  'SCHEMA_FAILURE',
  'POLICY_REJECTED',
  'UNAUTHORIZED',
]);

export function classifyFailure(code: string): RetryClassification {
  if (RETRYABLE_CODES.has(code)) return 'retryable';
  if (TERMINAL_CODES.has(code)) return 'terminal';
  return 'terminal';
}

export function computeBackoff(attempt: number, options: BackoffOptions): number {
  const exp = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempt - 1));
  // Deterministic jitter for repeatable spike tests: +50%, still bounded by max.
  return Math.min(options.maxMs, exp + Math.floor(exp / 2));
}

export function decideRetry(
  attempt: number,
  options: BackoffOptions,
  failureCode: string,
  now: Date = new Date(),
): RetryDecision {
  const classification = classifyFailure(failureCode);
  if (classification === 'terminal' || attempt >= options.maxAttempts) {
    return { outcome: 'terminal', retryable: false, nextDelayMs: null, nextAttemptAt: null };
  }
  const delay = computeBackoff(attempt, options);
  return {
    outcome: 'retryable',
    retryable: true,
    nextDelayMs: delay,
    nextAttemptAt: new Date(now.getTime() + delay),
  };
}

export function computeRequestFingerprint(payload: unknown): string {
  return fingerprint(stableStringify(payload));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}
