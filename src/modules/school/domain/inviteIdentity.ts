/**
 * BUG-20b — identity fields for accounts created by accepting a school invitation.
 *
 * `jwt_users` requires `name`, `username` (unique, /^[a-zA-Z0-9_.]{3,24}$/) and
 * `roles` NOT NULL, but the accept endpoint only receives `{ token, password }`.
 * The display name and username are therefore derived from the invited email.
 *
 * The derivation lives here instead of inside a store so the Postgres store and
 * the in-memory store cannot drift apart.
 */

/** Same pattern enforced by `POST /v1/auth/register` (JwtMultiRoleAuthService). */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_.]{3,24}$/;

const USERNAME_MAX_LENGTH = 24;
/** Leaves room for a numeric collision suffix without exceeding 24 chars. */
const USERNAME_BASE_MAX_LENGTH = 20;
const USERNAME_FALLBACK = 'pengguna';

/**
 * Local part of the email, sanitised to the username alphabet and padded to the
 * 3-char minimum. Uniqueness is the store's job (`usernameCandidate`).
 */
export function deriveUsernameBase(email: string): string {
  const local = (email.split('@')[0] ?? '').toLowerCase();
  let base = local.replace(/[^a-z0-9_.]/g, '').replace(/^[._]+/, '');
  base = base.slice(0, USERNAME_BASE_MAX_LENGTH).replace(/[._]+$/, '');
  if (base.length < 3) {
    base = `${USERNAME_FALLBACK}${base}`.slice(0, USERNAME_BASE_MAX_LENGTH);
  }
  if (!USERNAME_PATTERN.test(base)) return USERNAME_FALLBACK;
  return base;
}

/**
 * attempt 0 → the base itself, attempt n → base + (n+1), truncated to fit the
 * 24-char ceiling. Callers stop at the first candidate the database accepts.
 */
export function usernameCandidate(base: string, attempt: number): string {
  if (attempt <= 0) return base;
  const suffix = String(attempt + 1);
  return `${base.slice(0, USERNAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

/** Human-readable name for the invited account, e.g. `budi.santoso@x.id` → `Budi Santoso`. */
export function deriveDisplayName(email: string): string {
  const local = (email.split('@')[0] ?? '').trim();
  const words = local.split(/[._\-+]+/).filter((word) => word.length > 0);
  if (words.length === 0) return email;
  const name = words
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ')
    .trim();
  return name.length > 0 ? name.slice(0, 80) : email;
}
