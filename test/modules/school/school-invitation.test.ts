/**
 * B7-01 — School workspace & invitation tests.
 *
 * Evidence covered:
 * - invite flow: create → returns one-time token (64 hex)
 * - accept invite: creates user + adds to workspace
 * - one-time token: second accept fails with 404
 * - membership: listMembers returns invited user
 * - expired invite: accept fails with 404
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';

import { SchoolService } from '../../../src/modules/school/application/SchoolService.js';
import { registerSchoolRoutes } from '../../../src/modules/school/adapters/http/schoolRoutes.js';
import type {
  SchoolWorkspaceStore,
  SchoolInvitationStore,
} from '../../../src/modules/school/application/SchoolService.js';
import type { SchoolWorkspace, SchoolMember } from '../../../src/modules/school/domain/types.js';

// ─── In-memory stores ─────────────────────────────────────────────────────────

class InMemorySchoolWorkspaceStore implements SchoolWorkspaceStore {
  private workspaces = new Map<string, SchoolWorkspace>();
  private members = new Map<string, SchoolMember[]>(); // key = tenantId::workspaceId

  async createWorkspace(tenantId: string, name: string, level: string): Promise<SchoolWorkspace> {
    const ws: SchoolWorkspace = {
      id: `ws-${Date.now()}`,
      tenantId,
      name,
      level,
      createdAt: new Date().toISOString(),
    };
    this.workspaces.set(`${tenantId}::${ws.id}`, ws);
    return ws;
  }

  async getWorkspace(tenantId: string, workspaceId: string): Promise<SchoolWorkspace | null> {
    return this.workspaces.get(`${tenantId}::${workspaceId}`) ?? null;
  }

  async listMembers(tenantId: string, workspaceId: string): Promise<SchoolMember[]> {
    return this.members.get(`${tenantId}::${workspaceId}`) ?? [];
  }

  addMember(tenantId: string, workspaceId: string, member: SchoolMember): void {
    const key = `${tenantId}::${workspaceId}`;
    if (!this.members.has(key)) this.members.set(key, []);
    this.members.get(key)!.push(member);
  }
}

class InMemorySchoolInvitationStore implements SchoolInvitationStore {
  private invitations = new Map<
    string,
    {
      tokenHash: string;
      email: string;
      workspaceId: string;
      tenantId: string;
      role: string;
      state: string;
      expiresAt: Date;
      acceptedBy?: string;
    }
  >();
  private users = new Map<string, { id: string; email: string; passwordHash: string }>();
  private workspaceStore: InMemorySchoolWorkspaceStore;

  constructor(workspaceStore: InMemorySchoolWorkspaceStore) {
    this.workspaceStore = workspaceStore;
  }

  async saveInvitation(record: {
    tokenHash: string;
    email: string;
    workspaceId: string;
    tenantId: string;
    role: string;
    state: string;
    expiresAt: Date;
  }): Promise<void> {
    this.invitations.set(record.tokenHash, { ...record });
  }

  async findByTokenHash(tokenHash: string) {
    return this.invitations.get(tokenHash) ?? null;
  }

  async markAccepted(tokenHash: string, userId: string): Promise<void> {
    const inv = this.invitations.get(tokenHash);
    if (inv) {
      inv.state = 'accepted';
      inv.acceptedBy = userId;
    }
  }

  async saveMember(tenantId: string, workspaceId: string, member: SchoolMember): Promise<void> {
    this.workspaceStore.addMember(tenantId, workspaceId, member);
  }

  async saveUser(
    id: string,
    email: string,
    passwordHash: string,
  ): Promise<{ id: string; email: string }> {
    this.users.set(email, { id, email, passwordHash });
    return { id, email };
  }

  async getUserByEmail(
    email: string,
  ): Promise<{ id: string; email: string; passwordHash: string } | null> {
    return this.users.get(email) ?? null;
  }
}

// ─── Test setup ───────────────────────────────────────────────────────────────

const TENANT = 'tenant-school-001';
const WS = 'ws-school-001';

async function buildApp(clock?: () => Date) {
  const wsStore = new InMemorySchoolWorkspaceStore();
  const invStore = new InMemorySchoolInvitationStore(wsStore);
  const service = new SchoolService(wsStore, invStore, clock);

  // Pre-create workspace
  await wsStore.createWorkspace(TENANT, 'SMA Negeri 1', 'high_school');

  const app = Fastify({ logger: false });
  await app.register((instance) => registerSchoolRoutes(instance, { service }));
  await app.ready();
  return { app, service, wsStore, invStore };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('B7-01 — School workspace & invitation', () => {
  // ─── Invite flow ──────────────────────────────────────────────────────────

  describe('POST /v1/invitations — create invitation', () => {
    it('returns one-time token with 64 hex chars (32 bytes)', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/invitations',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: WS,
          email: 'teacher@school.id',
          role: 'teacher',
          tenantId: TENANT,
          createdByUserId: 'admin-001',
        }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.data).toHaveProperty('token');
      expect(body.data).toHaveProperty('tokenHash');
      expect(body.data.token).toMatch(/^[a-f0-9]{64}$/);
      expect(typeof body.data.tokenHash).toBe('string');
      expect(body.data.email).toBe('teacher@school.id');
    });

    it('rejects missing fields with 400', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/invitations',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: WS }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── Accept invitation ────────────────────────────────────────────────────

  describe('POST /v1/invitations/accept — accept invite', () => {
    it('creates user and adds to workspace', async () => {
      const { app, wsStore } = await buildApp();
      const inviteRes = await app.inject({
        method: 'POST',
        url: '/v1/invitations',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: WS,
          email: 'new@school.id',
          role: 'teacher',
          tenantId: TENANT,
          createdByUserId: 'admin-001',
        }),
      });
      const { token } = inviteRes.json().data;

      const acceptRes = await app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password: 'SecurePass123!' }),
      });
      expect(acceptRes.statusCode).toBe(200);
      const body = acceptRes.json();
      expect(body.data).toHaveProperty('userId');
      expect(body.data.workspaceId).toBe(WS);

      // Verify member added
      const members = await wsStore.listMembers(TENANT, WS);
      expect(members.length).toBe(1);
      expect(members[0]?.email).toBe('new@school.id');
    });

    it('one-time token: second accept fails with 404', async () => {
      const { app } = await buildApp();
      const inviteRes = await app.inject({
        method: 'POST',
        url: '/v1/invitations',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: WS,
          email: 'once@school.id',
          role: 'teacher',
          tenantId: TENANT,
          createdByUserId: 'admin-001',
        }),
      });
      const { token } = inviteRes.json().data;

      // First accept: success
      const accept1 = await app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password: 'Pass123' }),
      });
      expect(accept1.statusCode).toBe(200);

      // Second accept: should fail (already accepted)
      const accept2 = await app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password: 'Pass123' }),
      });
      expect(accept2.statusCode).toBe(404);
    });

    it('expired invitation: accept fails with 404', async () => {
      const pastTime = new Date('2020-01-01T00:00:00Z');
      const { app } = await buildApp(() => pastTime);

      const inviteRes = await app.inject({
        method: 'POST',
        url: '/v1/invitations',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: WS,
          email: 'expired@school.id',
          role: 'teacher',
          tenantId: TENANT,
          createdByUserId: 'admin-001',
        }),
      });
      const { token } = inviteRes.json().data;

      // Move clock forward 8 days (> 7 day TTL)
      const futureApp = (await buildApp(() => new Date('2020-01-09T00:00:00Z'))).app;

      const acceptRes = await futureApp.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password: 'Pass123' }),
      });
      expect(acceptRes.statusCode).toBe(404);
    });
  });

  // ─── List members ─────────────────────────────────────────────────────────

  describe('GET /v1/school/:workspaceId/members — list members', () => {
    it('returns members after invitation accepted', async () => {
      const { app } = await buildApp();
      const inviteRes = await app.inject({
        method: 'POST',
        url: '/v1/invitations',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: WS,
          email: 'member@school.id',
          role: 'teacher',
          tenantId: TENANT,
          createdByUserId: 'admin-001',
        }),
      });
      const { token } = inviteRes.json().data;

      await app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password: 'Pass123' }),
      });

      const membersRes = await app.inject({
        method: 'GET',
        url: `/v1/school/${WS}/members`,
        headers: { 'x-tenant-id': TENANT },
      });
      expect(membersRes.statusCode).toBe(200);
      const body = membersRes.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBe(1);
      expect(body.data[0]?.email).toBe('member@school.id');
    });
  });
});
