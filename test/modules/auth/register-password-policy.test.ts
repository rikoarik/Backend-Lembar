/**
 * HTTP-level regression test for `POST /v1/auth/register` password policy.
 *
 * BUG-20b / t_c3e6a292: a weak password used to answer
 * `500 { code: 'INTERNAL_ERROR', retryable: true }` because
 * `throwApiError('password_policy', ...)` had no entry in the shorthand ->
 * StableErrorCode map. The route never touched the database in that path, so a
 * client retrying could never succeed — the FE/BFF treats 5xx as retryable.
 *
 * The test mounts the real route + the real shared error handlers, and gives the
 * service a database double that throws if it is used: a weak password must be
 * rejected by the policy *before* any persistence happens.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { registerErrorHandlers } from '../../../src/bootstrap/errorHandlers.js';
import { registerJwtMultiRoleRoutes } from '../../../src/modules/auth/adapters/http/jwtMultiRoleRoutes.js';
import type { Database } from '../../../src/infrastructure/database/db.js';

const SECRET = 'register-password-policy-secret';

/** Any access to the database in the weak-password path is a bug. */
const untouchedDb = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(`database must not be touched on a password-policy failure (${String(prop)})`);
    },
  },
) as Database;

async function buildApp() {
  const app = Fastify({ logger: false });
  registerErrorHandlers(app);
  await registerJwtMultiRoleRoutes(app, {
    db: untouchedDb,
    jwtSecret: SECRET,
    jwtExpiryDays: 1,
  });
  await app.ready();
  return app;
}

function register(password: string, email = 'policy-probe@example.test') {
  return {
    method: 'POST' as const,
    url: '/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { email, password, name: 'Probe' },
  };
}

describe('POST /v1/auth/register password policy', () => {
  it('returns 400 VALIDATION_FAILED (not 500) for a weak password', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject(register('lemah'));

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.retryable).toBe(false);
      expect(body.error.message).toBe(
        'Kata sandi minimal 12 karakter, berisi huruf besar, angka, dan simbol',
      );
      expect(body.error.requestId).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('rejects each missing character class with the same 400 contract', async () => {
    const app = await buildApp();
    try {
      // panjang cukup, tapi tanpa huruf besar / angka / simbol
      for (const password of ['semuakecilpanjang', 'SEMUABESARPANJANG', 'TanpaSimbol12345']) {
        const res = await app.inject(register(password, `probe-${password.length}@example.test`));
        expect(res.statusCode, `password "${password}" harus 400`).toBe(400);
        expect(res.json().error.code).toBe('VALIDATION_FAILED');
        expect(res.json().error.retryable).toBe(false);
      }
    } finally {
      await app.close();
    }
  });

  it('does not report a 5xx / retryable envelope for bad input', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject(register('lemah'));
      expect(res.statusCode).toBeLessThan(500);
      expect(res.json().error.retryable).toBe(false);
      expect(res.json().error.code).not.toBe('INTERNAL_ERROR');
    } finally {
      await app.close();
    }
  });
});
