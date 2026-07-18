/**
 * Redaction utilities.
 *
 * Redacted values MUST NOT appear in logs/traces. We hash the value so a stable,
 * non-reversible fingerprint remains for correlation across log lines.
 */
import { createHash } from 'node:crypto';

/** Redaction sentinel shown to humans; the underlying value is hashed. */
export const REDACTED = '[redacted]';

/**
 * Produce a short, non-reversible fingerprint for a sensitive value.
 * Used in log fields instead of the value itself.
 */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/**
 * Convert a key/signed-url/secret into a safe log-shape. The original value
 * is never returned or stored; only a short fingerprint is kept.
 */
export interface SafeLogShape {
  fingerprint: string;
  byteLength?: number;
}

export function safeLogShape(value: string): SafeLogShape {
  return {
    fingerprint: fingerprint(value),
    byteLength: Buffer.byteLength(value, 'utf8'),
  };
}
