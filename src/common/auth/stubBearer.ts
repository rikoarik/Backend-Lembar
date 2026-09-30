import { timingSafeEqual } from 'node:crypto';

/**
 * Stub-bearer verification shared by the internal write surfaces that are not
 * yet wired to the B1-03 permission layer (curriculum catalog writes,
 * notification dispatch).
 *
 * The invariant that matters here — and that AUDIT-2 / t_02e3d131 found broken
 * in production — is: **an unset/empty configured token must deny every
 * request.** The previous inline check read
 * `token.length > 0 && (expected === null || token === expected)`, so an empty
 * `CURRICULUM_WRITE_TOKEN` turned `Bearer junk` into a valid credential and let
 * any caller perform real, committed curriculum writes.
 */
export function bearerTokenFrom(authorization: string | string[] | undefined): string {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof raw !== 'string' || !raw.startsWith('Bearer ')) return '';
  return raw.slice('Bearer '.length).trim();
}

/**
 * Constant-time check of a presented stub bearer against the configured value.
 *
 * Denies when either side is empty: a missing configuration is a closed door,
 * never an open one.
 */
export function stubBearerAllowed(configured: string | null, presented: string): boolean {
  if (configured === null || configured.length === 0) return false;
  if (presented.length === 0) return false;
  const expected = Buffer.from(configured, 'utf8');
  const actual = Buffer.from(presented, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
