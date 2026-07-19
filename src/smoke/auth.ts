// Auth spike CLI smoke. Exercises the contract flow against an in-process Fastify
// app wired to the DB-backed auth store when DATABASE_URL is set. Exits `0` on success, `1` on any failure
// with a redacted envelope.
//
// Usage:
//   pnpm build && node dist/smoke/auth.js

import { closeDatabase, createDatabase } from '../infrastructure/database/db.js';
import { buildApp } from '../bootstrap/app.js';
import { InMemoryAuthStore } from '../modules/auth/adapters/persistence/InMemoryAuthStore.js';
import { PostgresAuthStore } from '../modules/auth/adapters/persistence/PostgresAuthStore.js';
import { createAuthService } from '../modules/auth/application/createAuthService.js';
import type {
  NotificationAdapter,
  NotificationSendInput,
  NotificationSendResult,
} from '../modules/notifications/domain/NotificationAdapter.js';

interface SmokeStep {
  label: string;
  ok: boolean;
  detail: string;
}

interface MeBody {
  data: {
    account: { id: string; displayName: string };
    activeWorkspaceId: string;
    workspaces: Array<{ id: string; type: 'personal' | 'school'; name: string; role: string }>;
  };
}

type CookieJar = Record<string, string>;

const ALLOWED_ORIGIN = 'http://localhost:3000';
const BOOTSTRAP_CSRF = 'bootstrap';

type Runtime = {
  auth: ReturnType<typeof createAuthService>;
  tokenFromNotification(templateKey: string): string | null;
  close(): Promise<void>;
};

function createRuntime(): Runtime {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl) {
    const db = createDatabase({ connectionString: databaseUrl });
    const adapter = new RecordingNotificationAdapter();
    return {
      auth: createAuthService({
        store: new PostgresAuthStore({ db, notificationAdapter: adapter }),
      }),
      tokenFromNotification: (templateKey) => adapter.tokenFromNotification(templateKey),
      close: () => closeDatabase(db),
    };
  }

  const store = new InMemoryAuthStore();
  return {
    auth: createAuthService({ store }),
    tokenFromNotification: (templateKey) => store.tokenFromNotification(templateKey),
    close: async () => {},
  };
}

async function main(): Promise<void> {
  const steps: SmokeStep[] = [];
  const runtime = createRuntime();
  const app = await buildApp({ logger: false, auth: runtime.auth });
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
    steps.push(
      step(
        'me-personal-workspace-context',
        meBody.data.workspaces.some(
          (workspace) =>
            workspace.id === meBody.data.activeWorkspaceId && workspace.type === 'personal',
        ),
        me.statusCode,
      ),
    );
    const switched = await app.inject({
      method: 'POST',
      url: '/v1/auth/workspace/switch',
      headers: { origin: ALLOWED_ORIGIN, 'x-csrf-token': loginCsrf },
      cookies: loginCookies,
      payload: { workspaceId: meBody.data.activeWorkspaceId },
    });
    steps.push(
      step('csrf-passed-and-workspace-switch', switched.statusCode === 200, switched.statusCode),
    );

    await runtime.auth.requestRecovery({ email });
    const recoveryToken = runtime.tokenFromNotification('auth.recovery');
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

    await runtime.auth.createSchoolInvitation({
      email: `invitee-${Date.now()}@example.test`,
      role: 'teacher',
      workspaceId: meBody.data.activeWorkspaceId,
      createdByUserId: meBody.data.account.id,
    });
    const inviteToken = runtime.tokenFromNotification('workspace.invite');
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
    await runtime.close();
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

class RecordingNotificationAdapter implements NotificationAdapter {
  private readonly tokens = new Map<string, string>();

  async send(input: NotificationSendInput): Promise<NotificationSendResult> {
    const code = input.payload['code'];
    if (typeof code === 'string') this.tokens.set(input.templateKey, code);
    const acceptUrl = input.payload['accept_url'];
    if (typeof acceptUrl === 'string') {
      this.tokens.set(input.templateKey, new URL(acceptUrl).searchParams.get('token') ?? '');
    }
    return { id: input.eventId, status: 'dispatched' };
  }

  tokenFromNotification(templateKey: string): string | null {
    return this.tokens.get(templateKey) ?? null;
  }
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
