// Auth spike CLI smoke. Exercises the contract flow against an in-process Fastify
// app wired to an in-memory auth store. Exits `0` on success, `1` on any failure
// with a redacted envelope.
//
// Usage:
//   pnpm build && node dist/smoke/auth.js

import { buildApp } from '../bootstrap/app.js';
import { InMemoryAuthStore } from '../modules/auth/adapters/persistence/InMemoryAuthStore.js';
import { createAuthService } from '../modules/auth/application/createAuthService.js';

interface SmokeStep {
  label: string;
  ok: boolean;
  detail: string;
}

interface MeBody {
  userId: string;
  activeWorkspaceId: string;
  workspaceIds: string[];
}

type CookieJar = Record<string, string>;

const ALLOWED_ORIGIN = 'http://localhost:3000';
const BOOTSTRAP_CSRF = 'bootstrap';

async function main(): Promise<void> {
  const steps: SmokeStep[] = [];
  const store = new InMemoryAuthStore();
  const auth = createAuthService({ store });
  const app = await buildApp({ logger: false, auth });
  await app.ready();

  try {
    const email = `smoke-${Date.now()}@example.test`;

    const register = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { origin: ALLOWED_ORIGIN, 'x-csrf-token': BOOTSTRAP_CSRF },
      payload: { email, password: 'passphrase-1' },
    });
    const registerCookies = collectCookies(register.cookies);
    steps.push(step('register', register.statusCode === 201, register.statusCode));

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: ALLOWED_ORIGIN, 'x-csrf-token': BOOTSTRAP_CSRF },
      payload: { email, password: 'passphrase-1' },
    });
    const loginCookies = collectCookies(login.cookies);
    const loginCsrf = requireCookie(login.cookies, 'lembar_csrf');
    steps.push(step('login', login.statusCode === 200, login.statusCode));

    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/auth/workspace/switch',
      headers: { 'x-csrf-token': 'invalid' },
      cookies: loginCookies,
      payload: { workspaceId: '00000000-0000-0000-0000-000000000000' },
    });
    steps.push(step('csrf-blocked', blocked.statusCode === 403, blocked.statusCode));

    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      cookies: loginCookies,
    });
    const meBody = me.json() as MeBody;
    const switched = await app.inject({
      method: 'POST',
      url: '/v1/auth/workspace/switch',
      headers: { origin: ALLOWED_ORIGIN, 'x-csrf-token': loginCsrf },
      cookies: loginCookies,
      payload: { workspaceId: meBody.activeWorkspaceId },
    });
    steps.push(
      step('csrf-passed-and-workspace-switch', switched.statusCode === 200, switched.statusCode),
    );

    await auth.requestRecovery({ email });
    const recoveryToken = store.tokenFromNotification('auth.recovery');
    if (!recoveryToken) throw new Error('recovery notification token missing');
    const recovery = await app.inject({
      method: 'POST',
      url: '/v1/auth/recovery/complete',
      headers: { origin: ALLOWED_ORIGIN, 'x-csrf-token': BOOTSTRAP_CSRF },
      payload: { token: recoveryToken, newPassword: 'passphrase-2' },
    });
    const recoveryCookies = collectCookies(recovery.cookies);
    steps.push(step('recovery-complete', recovery.statusCode === 200, recovery.statusCode));

    const oldSessionMe = await app.inject({
      method: 'GET',
      url: '/v1/me',
      cookies: loginCookies,
    });
    steps.push(
      step('old-session-revoked', oldSessionMe.statusCode === 401, oldSessionMe.statusCode),
    );

    const recoveryMe = await app.inject({
      method: 'GET',
      url: '/v1/me',
      cookies: recoveryCookies,
    });
    steps.push(
      step('recovery-session-usable', recoveryMe.statusCode === 200, recoveryMe.statusCode),
    );

    const oldPasswordLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: ALLOWED_ORIGIN, 'x-csrf-token': BOOTSTRAP_CSRF },
      payload: { email, password: 'passphrase-1' },
    });
    steps.push(
      step(
        'old-password-rejected',
        oldPasswordLogin.statusCode === 400,
        oldPasswordLogin.statusCode,
      ),
    );

    const newPasswordLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: ALLOWED_ORIGIN, 'x-csrf-token': BOOTSTRAP_CSRF },
      payload: { email, password: 'passphrase-2' },
    });
    steps.push(
      step(
        'login-after-recovery',
        newPasswordLogin.statusCode === 200,
        newPasswordLogin.statusCode,
      ),
    );

    await auth.createSchoolInvitation({
      email: `invitee-${Date.now()}@example.test`,
      role: 'teacher',
      workspaceId: meBody.activeWorkspaceId,
      createdByUserId: meBody.userId,
    });
    const inviteToken = store.tokenFromNotification('workspace.invite');
    if (!inviteToken) throw new Error('invite notification token missing');
    const consume = await app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/consume',
      headers: { origin: ALLOWED_ORIGIN, 'x-csrf-token': BOOTSTRAP_CSRF },
      payload: { token: inviteToken, password: 'passphrase-1' },
    });
    steps.push(step('invitation-consume', consume.statusCode === 200, consume.statusCode));

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/consume',
      headers: { origin: ALLOWED_ORIGIN, 'x-csrf-token': BOOTSTRAP_CSRF },
      payload: { token: inviteToken, password: 'passphrase-1' },
    });
    steps.push(step('invitation-replay-rejected', replay.statusCode === 400, replay.statusCode));

    const genericRecovery = await app.inject({
      method: 'POST',
      url: '/v1/auth/recovery/request',
      headers: { origin: ALLOWED_ORIGIN, 'x-csrf-token': BOOTSTRAP_CSRF },
      payload: { email: 'missing@example.test' },
    });
    steps.push(
      step(
        'recovery-enumeration-safe',
        genericRecovery.statusCode === 202,
        genericRecovery.statusCode,
      ),
    );

    const duplicateRegister = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { origin: ALLOWED_ORIGIN, 'x-csrf-token': BOOTSTRAP_CSRF },
      payload: { email, password: 'passphrase-1' },
    });
    steps.push(
      step(
        'register-enumeration-safe',
        duplicateRegister.statusCode === 202,
        duplicateRegister.statusCode,
      ),
    );

    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: {
        origin: ALLOWED_ORIGIN,
        'x-csrf-token': requireCookie(newPasswordLogin.cookies, 'lembar_csrf'),
      },
      cookies: collectCookies(newPasswordLogin.cookies),
    });
    steps.push(step('logout', logout.statusCode === 204, logout.statusCode));

    const logoutMe = await app.inject({
      method: 'GET',
      url: '/v1/me',
      cookies: collectCookies(newPasswordLogin.cookies),
    });
    steps.push(step('logout-revoked-session', logoutMe.statusCode === 401, logoutMe.statusCode));

    const registerMe = await app.inject({
      method: 'GET',
      url: '/v1/me',
      cookies: registerCookies,
    });
    steps.push(
      step('register-session-rotated-away', registerMe.statusCode === 401, registerMe.statusCode),
    );
  } finally {
    await app.close();
  }

  const failed = steps.filter((entry) => !entry.ok);
  const summary = {
    ok: failed.length === 0,
    steps,
    redaction: 'passwords/tokens/session-cookies not printed',
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

function step(label: string, ok: boolean, statusCode: number): SmokeStep {
  return { label, ok, detail: `status=${statusCode}` };
}

function collectCookies(cookies: ReadonlyArray<{ name: string; value: string }>): CookieJar {
  const jar: CookieJar = {};
  for (const cookie of cookies) jar[cookie.name] = cookie.value;
  return jar;
}

function requireCookie(
  cookies: ReadonlyArray<{ name: string; value: string }>,
  name: string,
): string {
  const cookie = cookies.find((entry) => entry.name === name);
  if (!cookie) throw new Error(`${name} cookie missing`);
  return cookie.value;
}

main().catch((err) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: redactError(err) }, null, 2)}\n`);
  process.exit(1);
});

function redactError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'UnknownError', message: 'see logs' };
}
