/**
 * Tests for school member management endpoints:
 *   GET    /v1/school/members
 *   POST   /v1/school/members/invite
 *   PATCH  /v1/school/members/:id/role
 *   DELETE /v1/school/members/:id
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';

import { SchoolService } from '../../../src/modules/school/application/SchoolService.js';
import { InMemorySchoolWorkspaceStore, InMemorySchoolInvitationStore } from '../../../src/modules/school/persistence/InMemorySchoolStores.js';
import { registerMemberRoutes } from '../../../src/modules/school/adapters/http/memberRoutes.js';
import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';

const JWT_SECRET = 'school-members-test-secret';

async function buildApp() {
  const app = Fastify({ logger: false });
  const workspaceStore = new InMemorySchoolWorkspaceStore();
  const invitationStore = new InMemorySchoolInvitationStore();
  const service = new SchoolService(workspaceStore, invitationStore);

  // Seed a workspace with members
  workspaceStore.seedWorkspace(
    { id: 'ws-001', tenantId: 'ws-001', name: 'Test School', level: 'sd', createdAt: new Date().toISOString() },
    [
      { id: 'mem-001', email: 'teacher@test.school', role: 'teacher', state: 'active', joinedAt: new Date().toISOString() },
      { id: 'mem-002', email: 'admin@test.school', role: 'school_admin', state: 'active', joinedAt: new Date().toISOString() },
    ],
  );

  registerMemberRoutes(app, { service, jwtSecret: JWT_SECRET });
  await app.ready();
  return app;
}

function authHeaders(roles: ('school_admin' | 'teacher')[]) {
  return {
    authorization: `Bearer ${generateJwt({ userId: 'mem-002', email: 'admin@test.school', roles, workspaceId: 'ws-001' }, { secret: JWT_SECRET, expiryDays: 1 })}`,
    'content-type': 'application/json',
  };
}

const adminHeaders = authHeaders(['school_admin']);

describe('GET /v1/school/members', () => {
  it('returns members for school_admin', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/school/members',
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(2);
  });

  it('returns 403 for non-admin role', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/school/members',
      headers: authHeaders(['teacher']),
    });
    expect(res.statusCode).toBe(403);
  });

});

describe('POST /v1/school/members/invite', () => {
  it('creates invitation for valid input', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/school/members/invite',
      headers: { ...adminHeaders, 'x-user-id': 'mem-002' },
      body: JSON.stringify({ email: 'newteacher@test.school', role: 'teacher' }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { data: { token: string; email: string } };
    expect(body.data.token).toBeTruthy();
    expect(body.data.email).toBe('newteacher@test.school');
  });

  it('returns 400 for missing email', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/school/members/invite',
      headers: adminHeaders,
      body: JSON.stringify({ role: 'teacher' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid role', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/school/members/invite',
      headers: adminHeaders,
      body: JSON.stringify({ email: 'x@test.school', role: 'superadmin' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 for non-admin', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/school/members/invite',
      headers: authHeaders(['teacher']),
      body: JSON.stringify({ email: 'x@test.school', role: 'teacher' }),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('PATCH /v1/school/members/:id/role', () => {
  it('updates member role', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/school/members/mem-001/role',
      headers: adminHeaders,
      body: JSON.stringify({ role: 'school_admin' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { role: string } };
    expect(body.data.role).toBe('school_admin');
  });

  it('returns 404 for unknown member', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/school/members/does-not-exist/role',
      headers: adminHeaders,
      body: JSON.stringify({ role: 'teacher' }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for missing role', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/school/members/mem-001/role',
      headers: adminHeaders,
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /v1/school/members/:id', () => {
  it('removes an existing member', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/school/members/mem-001',
      headers: { authorization: adminHeaders.authorization },
    });
    expect(res.statusCode).toBe(204);
  });

  it('returns 404 for unknown member', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/school/members/does-not-exist',
      headers: { authorization: adminHeaders.authorization },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 for non-admin', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/school/members/mem-001',
      headers: { authorization: authHeaders(['teacher']).authorization },
    });
    expect(res.statusCode).toBe(403);
  });
});
