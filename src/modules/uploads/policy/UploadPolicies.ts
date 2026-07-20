/**
 * B2-01 — Upload policy constants.
 *
 * Pure constants; no dependencies. Anywhere outside the modules that reads
 * these values must import them from here.
 */
export const PDF_MAGIC_PREFIX = Buffer.from('%PDF-', 'utf8');
// Trailer must contain `%%EOF` close to end-of-file. We scan only the tail
// window because real PDF producers often append whitespace or PS marks after.
export const PDF_TRAILER_MARKER = '%%EOF';
export const PDF_TRAILER_SCAN_WINDOW = 1024;

/**
 * Env override default for SOURCE_UPLOAD_MAX_BYTES (50 MiB).
 * 50 * 1024 * 1024 = 52_428_800 bytes.
 */
export const DEFAULT_SOURCE_UPLOAD_MAX_BYTES = 52_428_800;

/**
 * Fixed short-lived signed-URL lifetime for source downloads. Storage adapters
 * enforce their own hard ceiling (900s); we keep below that.
 */
export const SOURCE_SIGNED_URL_TTL_SECONDS = 300;

/**
 * Allowed content type for source uploads. Single value for MVP per
 * SECURITY-PRIVACY-OPERATIONS.md upload/source section.
 */
export const SOURCE_UPLOAD_CONTENT_TYPE = 'application/pdf';

export const FILENAME_REDACTION_PLACEHOLDER = '[redacted-filename]';

/**
 * Token used to expose an opaque fingerprint of the storage key in audit/log
 * output. Never include the raw storage key.
 */
export function redactionClassificationForStatus(
  status: 'received' | 'verified' | 'rejected' | 'deleted',
): 'pending_review' | 'user_private' | 'pending_review' {
  if (status === 'verified') return 'user_private';
  if (status === 'received') return 'pending_review';
  return 'pending_review';
}
