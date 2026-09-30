import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bearerTokenFrom, stubBearerAllowed } from '../../../src/common/auth/stubBearer.js';
import { ConfigError } from '../../../src/config/errors.js';
import { assertCurriculumWriteTokenConfigured } from '../../../src/config/curriculum.env.js';
import { registerErrorHandlers } from '../../../src/bootstrap/errorHandlers.js';
import { registerCurriculumRoutes } from '../../../src/modules/curriculum/adapters/http/routes.js';

/**
 * AUDIT-2 / t_02e3d131 regression suite.
 *
 * Live before the fix, with `CURRICULUM_WRITE_TOKEN=` (empty) deployed,
 * `Authorization: Bearer junk` passed the guard and performed committed
 * curriculum writes. These cases lock the fail-closed behavior so an
 * unset/empty token can never again mean "accept anything".
 */

const CONFIGURED = 'configured-curriculum-token';
const ENV_KEY = 'CURRICULUM_WRITE_TOKEN';

function savedEnv(): string | undefined {
  return process.env[ENV_KEY];
}

let originalToken: string | undefined;
let originalAppEnv: string | undefined;

beforeEach(() => {
  originalToken = savedEnv();
  originalAppEnv = process.env['APP_ENV'];
  delete process.env[ENV_KEY];
  delete process.env['APP_ENV'];
});

afterEach(() => {
  if (originalToken === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalToken;
  if (originalAppEnv === undefined) delete process.env['APP_ENV'];
  else process.env['APP_ENV'] = originalAppEnv;
});

/**
 * Mount the real curriculum routes over a stub db. The chosen probe route
 * (`source-rights-gate` on a non-material resource) answers `{ok:true}` without
 * touching the database, so this exercises the genuine Fastify route + the
 * genuine `bearerActor` guard — no DB required.
 */
async function curriculumApp() {
  const app = Fastify({ logger: false });
  registerErrorHandlers(app);
  await registerCurriculumRoutes(app, { db: {} as never });
  await app.ready();
  return app;
}

function gateRequest(app: Awaited<ReturnType<typeof curriculumApp>>, authorization?: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/curriculum/curricula/00000000-0000-0000-0000-000000000000/source-rights-gate',
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  });
}

describe('curriculum write bearer fails closed (t_02e3d131)', () => {
  it('401 when CURRICULUM_WRITE_TOKEN is unset, even for a non-empty Bearer token', async () => {
    const app = await curriculumApp();
    try {
      const noHeader = await gateRequest(app);
      expect(noHeader.statusCode).toBe(401);
      expect(noHeader.json().error.code).toBe('AUTH_REQUIRED');

      // The AUDIT-2 live reproduction: this used to return 200.
      const forged = await gateRequest(app, 'Bearer junk');
      expect(forged.statusCode).toBe(401);
      expect(forged.json().error.code).toBe('AUTH_REQUIRED');

      const empty = await gateRequest(app, 'Bearer ');
      expect(empty.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('401 when CURRICULUM_WRITE_TOKEN is set to the empty string', async () => {
    process.env[ENV_KEY] = '';
    const app = await curriculumApp();
    try {
      const forged = await gateRequest(app, 'Bearer junk');
      expect(forged.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('401 for a wrong-but-non-empty token, 200 only for the exact configured token', async () => {
    process.env[ENV_KEY] = CONFIGURED;
    const app = await curriculumApp();
    try {
      const wrong = await gateRequest(app, 'Bearer not-the-configured-token');
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json().error.code).toBe('AUTH_REQUIRED');

      const prefix = await gateRequest(app, `Bearer ${CONFIGURED.slice(0, -1)}`);
      expect(prefix.statusCode).toBe(401);

      const noBearerScheme = await gateRequest(app, CONFIGURED);
      expect(noBearerScheme.statusCode).toBe(401);

      const exact = await gateRequest(app, `Bearer ${CONFIGURED}`);
      expect(exact.statusCode).toBe(200);
      expect(exact.json()).toEqual({ data: { ok: true, reason: null } });
    } finally {
      await app.close();
    }
  });

  it('trims a configured token but still requires an exact match', async () => {
    process.env[ENV_KEY] = `  ${CONFIGURED}  `;
    const app = await curriculumApp();
    try {
      const exact = await gateRequest(app, `Bearer ${CONFIGURED}`);
      expect(exact.statusCode).toBe(200);

      const withPadding = await gateRequest(app, `Bearer   ${CONFIGURED}  `);
      expect(withPadding.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('stubBearerAllowed', () => {
  it('denies whenever the configured value is missing or empty', () => {
    expect(stubBearerAllowed(null, 'anything')).toBe(false);
    expect(stubBearerAllowed('', 'anything')).toBe(false);
    expect(stubBearerAllowed(null, '')).toBe(false);
  });

  it('denies an empty presented token and allows only an exact match', () => {
    expect(stubBearerAllowed(CONFIGURED, '')).toBe(false);
    expect(stubBearerAllowed(CONFIGURED, 'other')).toBe(false);
    expect(stubBearerAllowed(CONFIGURED, CONFIGURED)).toBe(true);
  });

  it('rejects a length-mismatched value without throwing', () => {
    expect(stubBearerAllowed(CONFIGURED, `${CONFIGURED}x`)).toBe(false);
    expect(stubBearerAllowed(CONFIGURED, CONFIGURED.slice(1))).toBe(false);
  });
});

describe('bearerTokenFrom', () => {
  it('extracts only a well-formed Bearer credential', () => {
    expect(bearerTokenFrom('Bearer abc')).toBe('abc');
    expect(bearerTokenFrom('Bearer  abc  ')).toBe('abc');
    expect(bearerTokenFrom('abc')).toBe('');
    expect(bearerTokenFrom('Basic abc')).toBe('');
    expect(bearerTokenFrom(undefined)).toBe('');
    expect(bearerTokenFrom(['Bearer first', 'Bearer second'])).toBe('first');
  });
});

describe('assertCurriculumWriteTokenConfigured (boot guard)', () => {
  it('throws a ConfigError naming only the key when production has no token', () => {
    expect(() => assertCurriculumWriteTokenConfigured({ APP_ENV: 'production' })).toThrow(
      ConfigError,
    );
    try {
      assertCurriculumWriteTokenConfigured({ APP_ENV: 'production', CURRICULUM_WRITE_TOKEN: '' });
      throw new Error('expected a ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues).toEqual([
        expect.objectContaining({ key: 'CURRICULUM_WRITE_TOKEN' }),
      ]);
    }
  });

  it('passes in production once a token is configured', () => {
    expect(() =>
      assertCurriculumWriteTokenConfigured({
        APP_ENV: 'production',
        CURRICULUM_WRITE_TOKEN: CONFIGURED,
      }),
    ).not.toThrow();
  });

  it('does not require a token outside production', () => {
    for (const appEnv of ['local', 'test', 'preview', 'staging', undefined]) {
      expect(() =>
        assertCurriculumWriteTokenConfigured(appEnv === undefined ? {} : { APP_ENV: appEnv }),
      ).not.toThrow();
    }
  });
});
