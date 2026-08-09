import { beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';
import { SchoolService } from '../../../src/modules/school/application/SchoolService.js';
import { SchoolDashboardService } from '../../../src/modules/school/application/SchoolDashboardService.js';
import { registerDashboardRoutes } from '../../../src/modules/school/adapters/http/dashboardRoutes.js';
import { registerMemberRoutes } from '../../../src/modules/school/adapters/http/memberRoutes.js';
import {
  InMemorySchoolInvitationStore,
  InMemorySchoolWorkspaceStore,
} from '../../../src/modules/school/persistence/InMemorySchoolStores.js';
import type { WorkspacePlanRepository } from '../../../src/modules/plans/persistence/repository.js';

const SECRET = 'school-admin-test-secret';
const WORKSPACE_ID = 'ws-school';
const ADMIN_ID = 'admin-1';

function token(userId: string, roles: ('school_admin' | 'teacher')[], workspaceId = WORKSPACE_ID) {
  return generateJwt(
    { userId, email: `${userId}@example.test`, roles, workspaceId },
    { secret: SECRET, expiryDays: 1 },
  );
}

function planRepo() {
  return {
    findOrCreate: async () => ({
      plan: 'free',
      generationsUsedThisMonth: 2,
      billingCycleStartedAt: new Date('2026-08-01T00:00:00Z'),
    }),
  } as unknown as WorkspacePlanRepository;
}

async function buildApp(members = [
  { id: ADMIN_ID, email: 'admin@example.test', role: 'school_admin' as const, state: 'active' as const, joinedAt: '2026-01-01T00:00:00Z' },
  { id: 'teacher-1', email: 'teacher@example.test', role: 'teacher' as const, state: 'active' as const, joinedAt: '2026-01-01T00:00:00Z' },
]) {
  const app = Fastify({ logger: false });
  const workspaceStore = new InMemorySchoolWorkspaceStore();
  workspaceStore.seedWorkspace(
    { id: WORKSPACE_ID, tenantId: WORKSPACE_ID, name: 'Sekolah JWT', level: 'sma', createdAt: '2026-01-01T00:00:00Z' },
    members,
  );
  const service = new SchoolService(workspaceStore, new InMemorySchoolInvitationStore());
  await registerDashboardRoutes(app, {
    dashboardService: new SchoolDashboardService(workspaceStore, planRepo()),
    jwtSecret: SECRET,
  });
  await registerMemberRoutes(app, { service, jwtSecret: SECRET });
  await app.ready();
  return app;
}

describe('school admin JWT hardening', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp();
  });

  it('dashboard scopes from verified JWT and ignores forged workspace headers/query', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/school/dashboard?workspaceId=attacker-workspace',
      headers: {
        authorization: `Bearer ${token(ADMIN_ID, ['school_admin'])}`,
        'x-tenant-id': 'attacker-tenant',
        'x-user-role': 'teacher',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.workspace.id).toBe(WORKSPACE_ID);
  });

  it('dashboard rejects forged legacy headers without a JWT', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/school/dashboard',
      headers: { 'x-tenant-id': WORKSPACE_ID, 'x-user-role': 'school_admin' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('member deletion rejects self-delete', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/school/members/${ADMIN_ID}`,
      headers: { authorization: `Bearer ${token(ADMIN_ID, ['school_admin'])}` },
    });

    expect(response.statusCode).toBe(400);
  });

  it('member deletion rejects removing the last active school admin', async () => {
    const onlyAdminApp = await buildApp([
      { id: ADMIN_ID, email: 'admin@example.test', role: 'school_admin', state: 'active', joinedAt: '2026-01-01T00:00:00Z' },
      { id: 'admin-2', email: 'other@example.test', role: 'school_admin', state: 'active', joinedAt: '2026-01-01T00:00:00Z' },
    ]);
    const response = await onlyAdminApp.inject({
      method: 'DELETE',
      url: `/v1/school/members/${ADMIN_ID}`,
      headers: { authorization: `Bearer ${token('admin-2', ['school_admin'])}` },
    });
    expect(response.statusCode).toBe(204);

    const lastAdminResponse = await onlyAdminApp.inject({
      method: 'DELETE',
      url: '/v1/school/members/admin-2',
      headers: { authorization: `Bearer ${token('new-admin', ['school_admin'])}` },
    });
    expect(lastAdminResponse.statusCode).toBe(409);
  });
});

describe('school member search', () => {
  it('q matches member name when the existing contract supplies one', async () => {
    const app = await buildApp([
      { id: ADMIN_ID, email: 'admin@example.test', name: 'Budi Santoso', role: 'school_admin', state: 'active', joinedAt: '2026-01-01T00:00:00Z' },
    ] as never);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/school/members?q=budi',
      headers: { authorization: `Bearer ${token(ADMIN_ID, ['school_admin'])}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
  });
});
