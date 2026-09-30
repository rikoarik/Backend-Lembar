/**
 * Single source of truth for the account password policy.
 *
 * `POST /v1/auth/register` and the school-invitation accept flow must enforce
 * exactly the same rule: if they drift, an invited user can set a password that
 * registration would have rejected (or vice versa) — and BUG-20b was found
 * precisely because the accept path skipped every register-time validation.
 */

export const PASSWORD_MIN_LENGTH = 12;

const UPPERCASE = /[A-Z]/;
const NUMBER = /\d/;
const SYMBOL = /[^A-Za-z0-9]/;

export const PASSWORD_POLICY_MESSAGE =
  'Kata sandi minimal 12 karakter, berisi huruf besar, angka, dan simbol';

export function isPasswordCompliant(password: string): boolean {
  return (
    password.length >= PASSWORD_MIN_LENGTH &&
    UPPERCASE.test(password) &&
    NUMBER.test(password) &&
    SYMBOL.test(password)
  );
}
