import { afterEach, describe, expect, test } from 'vitest';

import { buildApp } from '../../../src/bootstrap/app.js';
import { InMemoryAuthStore } from '../../../src/modules/auth/adapters/persistence/InMemoryAuthStore.js';
import { createAuthService } from '../../../src/modules/auth/application/createAuthService.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

async function makeApp() {
  const app = await buildApp({ logger: false, serviceName: 'test', serviceVersion: 'test' });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('auth routes', () => {
  test('blocks state-changing requests without allowed origin and missing csrf token', async () => {
    const app = await makeApp();

    const register = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'teacher@example.test', password: 'passphrase-1' },
    });

    expect(register.statusCode).toBe(403);
    expect(register.json()).toMatchObject({
      error: { code: 'PERMISSION_DENIED', message: 'Permintaan tidak diizinkan.' },
    });
  });

  test('accepts allowed-origin register, returns csrf token, and protects workspace switch', async () => {
    const app = await makeApp();

    const register = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: {
        origin: 'http://localhost:3000',
        'x-csrf-token': 'bootstrap',
      },
      payload: { email: 'teacher@example.test', password: 'passphrase-1' },
    });

    expect(register.statusCode).toBe(201);
    const sessionCookie = register.cookies.find((cookie) =>
      cookie.name.startsWith('__Host-lembar_session'),
    );
    const csrfCookie = register.cookies.find((cookie) => cookie.name === 'lembar_csrf');
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.secure).toBe(true);
    expect(csrfCookie?.value).toBeTruthy();

    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      cookies: {
        [sessionCookie!.name]: sessionCookie!.value,
      },
    });

    expect(me.statusCode).toBe(200);
    const body = me.json() as {
      data: {
        activeWorkspaceId: string;
        activeWorkspace: { id: string; permissions: string[]; isActive: boolean };
        context: { workspaceIds: string[]; permissionSet: string[] };
        workspaces: Array<{
          id: string;
          type: 'personal' | 'school';
          name: string;
          role: string;
          permissions: string[];
          isActive: boolean;
        }>;
      };
    };
    const activeWorkspace = body.data.workspaces.find(
      (workspace) => workspace.id === body.data.activeWorkspaceId,
    );
    expect(activeWorkspace?.type).toBe('personal');
    expect(activeWorkspace?.role).toBe('teacher');
    expect(activeWorkspace?.isActive).toBe(true);
    expect(activeWorkspace?.permissions).toEqual([
      'assessment.create',
      'assessment.read',
      'assessment.review',
      'source.manage',
    ]);
    expect(body.data.activeWorkspace).toEqual(activeWorkspace);
    expect(body.data.context).toEqual({
      workspaceIds: [body.data.activeWorkspaceId],
      permissionSet: activeWorkspace?.permissions,
    });

    const deniedByCsrf = await app.inject({
      method: 'POST',
      url: '/v1/auth/workspace/switch',
      cookies: {
        [sessionCookie!.name]: sessionCookie!.value,
        lembar_csrf: csrfCookie!.value,
      },
      payload: { workspaceId: '00000000-0000-0000-0000-000000000000' },
    });

    expect(deniedByCsrf.statusCode).toBe(403);
    expect(deniedByCsrf.json()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });

    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/auth/workspace/switch',
      headers: {
        origin: 'http://localhost:3000',
        'x-csrf-token': csrfCookie!.value,
      },
      cookies: {
        [sessionCookie!.name]: sessionCookie!.value,
        lembar_csrf: csrfCookie!.value,
      },
      payload: { workspaceId: '00000000-0000-0000-0000-000000000000' },
    });

    expect(blocked.statusCode).toBe(404);
    expect(blocked.json()).toMatchObject({ error: { code: 'WORKSPACE_ACCESS_DENIED' } });

    const allowed = await app.inject({
      method: 'POST',
      url: '/v1/auth/workspace/switch',
      headers: {
        origin: 'http://localhost:3000',
        'x-csrf-token': csrfCookie!.value,
      },
      cookies: {
        [sessionCookie!.name]: sessionCookie!.value,
        lembar_csrf: csrfCookie!.value,
      },
      payload: { workspaceId: body.data.activeWorkspaceId },
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ activeWorkspaceId: body.data.activeWorkspaceId });
    expect(body.data.workspaces.map((workspace) => workspace.id)).toContain(
      body.data.activeWorkspaceId,
    );
  });

  test('denies cross-tenant workspace switch and keeps /v1/me scoped to memberships', async () => {
    const store = new InMemoryAuthStore();
    const auth = createAuthService({ store });
    const app = await buildApp({
      logger: false,
      serviceName: 'test',
      serviceVersion: 'test',
      auth,
    });
    apps.push(app);

    const first = await auth.register({ email: 'first@example.test', password: 'passphrase-1' });
    const firstLogin = await auth.login({ email: 'first@example.test', password: 'passphrase-1' });
    const second = await auth.register({ email: 'second@example.test', password: 'passphrase-1' });

    const csrfToken = firstLogin.session.csrfToken;
    const switchForeign = await app.inject({
      method: 'POST',
      url: '/v1/auth/workspace/switch',
      headers: {
        origin: 'http://localhost:3000',
        'x-csrf-token': csrfToken,
      },
      cookies: {
        '__Host-lembar_session': firstLogin.session.id,
        lembar_csrf: csrfToken,
      },
      payload: { workspaceId: second.workspaceId },
    });
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      cookies: {
        '__Host-lembar_session': firstLogin.session.id,
      },
    });
    const dashboard = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/summary',
      cookies: {
        '__Host-lembar_session': firstLogin.session.id,
      },
    });

    expect(switchForeign.statusCode).toBe(404);
    expect(switchForeign.json()).toMatchObject({ error: { code: 'WORKSPACE_ACCESS_DENIED' } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ data: { activeWorkspaceId: first.workspaceId } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json()).toMatchObject({
      data: {
        workspace: { id: first.workspaceId, isActive: true },
        metrics: {
          assessments: { total: 0, draft: 0, inReview: 0, final: 0 },
          sources: { total: 0, ready: 0, processing: 0, failed: 0 },
          jobs: { total: 0, active: 0, failed: 0 },
        },
        emptyState: { isEmpty: true, message: 'Belum ada aktivitas pada workspace ini.' },
      },
    });
    expect(JSON.stringify(me.json())).not.toContain(second.workspaceId);
    expect(JSON.stringify(dashboard.json())).not.toContain(second.workspaceId);
  });

  test('workspace switch changes current read models only within memberships', async () => {
    const store = new InMemoryAuthStore();
    const auth = createAuthService({ store });
    const app = await buildApp({
      logger: false,
      serviceName: 'test',
      serviceVersion: 'test',
      auth,
    });
    apps.push(app);

    const registered = await auth.register({
      email: 'teacher@example.test',
      password: 'passphrase-1',
    });
    const login = await auth.login({ email: 'teacher@example.test', password: 'passphrase-1' });
    const schoolWorkspaceId = 'school-workspace';
    await store.saveWorkspace({
      id: schoolWorkspaceId,
      slug: 'school-workspace',
      name: 'Sekolah Uji',
    });
    await store.saveMembership({
      workspaceId: schoolWorkspaceId,
      userId: registered.userId,
      role: 'school_admin',
      state: 'active',
    });

    const csrfToken = login.session.csrfToken;
    const switched = await app.inject({
      method: 'POST',
      url: '/v1/auth/workspace/switch',
      headers: {
        origin: 'http://localhost:3000',
        'x-csrf-token': csrfToken,
      },
      cookies: {
        '__Host-lembar_session': login.session.id,
        lembar_csrf: csrfToken,
      },
      payload: { workspaceId: schoolWorkspaceId },
    });
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      cookies: { '__Host-lembar_session': login.session.id },
    });
    const dashboard = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/summary',
      cookies: { '__Host-lembar_session': login.session.id },
    });

    expect(switched.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      data: {
        activeWorkspaceId: schoolWorkspaceId,
        activeWorkspace: { id: schoolWorkspaceId, role: 'school_admin', isActive: true },
        workspaces: [
          { id: registered.workspaceId, isActive: false },
          { id: schoolWorkspaceId, isActive: true },
        ],
      },
    });
    expect(dashboard.json()).toMatchObject({
      data: { workspace: { id: schoolWorkspaceId, role: 'school_admin', isActive: true } },
    });
    expect(JSON.stringify(dashboard.json())).not.toContain('missing-workspace');
  });

  test('recovery and invitation endpoints stay enumeration-safe', async () => {
    const app = await makeApp();

    const recovery = await app.inject({
      method: 'POST',
      url: '/v1/auth/recovery/request',
      headers: {
        origin: 'http://localhost:3000',
        'x-csrf-token': 'bootstrap',
      },
      payload: { email: 'missing@example.test' },
    });

    expect(recovery.statusCode).toBe(202);
    expect(recovery.json()).toEqual({
      message: 'Jika akun ditemukan, instruksi pemulihan akan dikirim.',
    });

    const invite = await app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/consume',
      headers: {
        origin: 'http://localhost:3000',
        'x-csrf-token': 'bootstrap',
      },
      payload: { token: 'missing-token', password: 'passphrase-1' },
    });

    expect(invite.statusCode).toBe(400);
    expect(invite.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });
});
