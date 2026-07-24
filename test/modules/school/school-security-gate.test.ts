/**
 * B7-05 — School pilot security and operations gate.
 *
 * Integration tests covering:
 * - Tenant isolation end-to-end (workspace, members, dashboard, billing, onboarding)
 * - Admin-only routes reject non-admins (dashboard, billing)
 * - Invite tokens are single-use (replay protection)
 * - Role enforcement across all school endpoints
 *
 * Evidence:
 * [school-e2e, security-review, owner-acceptance]
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';

import { SchoolService } from '../../../src/modules/school/application/SchoolService.js';
import { SchoolDashboardService } from '../../../src/modules/school/application/SchoolDashboardService.js';
import { TeacherOnboardingService } from '../../../src/modules/school/application/TeacherOnboardingService.js';
import { SchoolBillingService } from '../../../src/modules/school/application/SchoolBillingService.js';
import { registerSchoolRoutes } from '../../../src/modules/school/adapters/http/schoolRoutes.js';
import { registerDashboardRoutes } from '../../../src/modules/school/adapters/http/dashboardRoutes.js';
import { registerOnboardingRoutes } from '../../../src/modules/school/adapters/http/onboardingRoutes.js';
import { registerBillingRoutes } from '../../../src/modules/school/adapters/http/billingRoutes.js';

import type {
  SchoolWorkspaceStore,
  SchoolInvitationStore,
} from '../../../src/modules/school/application/SchoolService.js';
import type { TeacherOnboardingStore } from '../../../src/modules/school/application/TeacherOnboardingService.js';
import type { WorkspacePlanRepository } from '../../../src/modules/plans/persistence/repository.js';
import type {
  SchoolWorkspace,
  SchoolMember,
  TeacherOnboardingRecord,
} from '../../../src/modules/school/domain/types.js';
import type { WorkspacePlan } from '../../../src/modules/plans/persistence/schema.js';

// ─── In-memory stores ─────────────────────────────────────────────────────────

class StubWorkspaceStore implements SchoolWorkspaceStore {
  private workspaces = new Map<string, SchoolWorkspace>();
  private members = new Map<string, SchoolMember[]>();

  seed(ws: SchoolWorkspace, members: SchoolMember[] = []): void {
    this.workspaces.set(`${ws.tenantId}::${ws.id}`, ws);
    this.members.set(`${ws.tenantId}::${ws.id}`, members);
  }

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
}

class StubInvitationStore implements SchoolInvitationStore {
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
  private workspaceStore: StubWorkspaceStore;

  constructor(workspaceStore: StubWorkspaceStore) {
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
    this.invitations.set(record.tokenHash, record);
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
    const key = `${tenantId}::${workspaceId}`;
    const members = this.workspaceStore['members'];
    if (!members.has(key)) members.set(key, []);
    members.get(key)!.push(member);
  }

  async saveUser(id: string, email: string, passwordHash: string) {
    const user = { id, email, passwordHash };
    this.users.set(email, user);
    return user;
  }

  async getUserByEmail(email: string) {
    return this.users.get(email) ?? null;
  }
}

class StubOnboardingStore implements TeacherOnboardingStore {
  private records = new Map<string, TeacherOnboardingRecord>();

  private key(userId: string, workspaceId: string): string {
    return `${userId}::${workspaceId}`;
  }

  async findRecord(userId: string, workspaceId: string): Promise<TeacherOnboardingRecord | null> {
    return this.records.get(this.key(userId, workspaceId)) ?? null;
  }

  async upsertRecord(record: TeacherOnboardingRecord): Promise<TeacherOnboardingRecord> {
    this.records.set(this.key(record.userId, record.workspaceId), record);
    return record;
  }
}

class StubPlanRepo {
  private plans = new Map<string, WorkspacePlan>();

  seed(tenantId: string, workspaceId: string, plan: Partial<WorkspacePlan> = {}): void {
    const key = `${tenantId}::${workspaceId}`;
    this.plans.set(key, {
      id: `plan-${Date.now()}`,
      tenantId,
      workspaceId,
      plan: 'free',
      generationsUsedThisMonth: 0,
      billingCycleStartedAt: new Date(),
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...plan,
    } as WorkspacePlan);
  }

  async findOrCreate(tenantId: string, workspaceId: string): Promise<WorkspacePlan> {
    const key = `${tenantId}::${workspaceId}`;
    if (!this.plans.has(key)) {
      this.seed(tenantId, workspaceId);
    }
    return this.plans.get(key)!;
  }
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

const TENANT_A = 'tenant-school-a';
const TENANT_B = 'tenant-school-b';
const WS_A = 'ws-alpha';
const WS_B = 'ws-beta';

function buildFullApp(
  workspaceStore: StubWorkspaceStore,
  invitationStore: StubInvitationStore,
  onboardingStore: StubOnboardingStore,
  planRepo: StubPlanRepo,
) {
  const app = Fastify({ logger: false });

  const schoolService = new SchoolService(workspaceStore, invitationStore);
  const dashboardService = new SchoolDashboardService(
    workspaceStore,
    planRepo as unknown as WorkspacePlanRepository,
  );
  const onboardingService = new TeacherOnboardingService(onboardingStore);
  const billingService = new SchoolBillingService(
    workspaceStore,
    planRepo as unknown as WorkspacePlanRepository,
  );

  void registerSchoolRoutes(app, { service: schoolService });
  void registerDashboardRoutes(app, { dashboardService });
  void registerOnboardingRoutes(app, { onboardingService });
  void registerBillingRoutes(app, { billingService });

  return app;
}

// ─── Integration tests ────────────────────────────────────────────────────────

describe('B7-05 — School security gate (integration)', () => {
  let workspaceStore: StubWorkspaceStore;
  let invitationStore: StubInvitationStore;
  let onboardingStore: StubOnboardingStore;
  let planRepo: StubPlanRepo;

  beforeEach(() => {
    workspaceStore = new StubWorkspaceStore();
    invitationStore = new StubInvitationStore(workspaceStore);
    onboardingStore = new StubOnboardingStore();
    planRepo = new StubPlanRepo();

    // Seed workspace A dengan 2 member
    workspaceStore.seed(
      { id: WS_A, tenantId: TENANT_A, name: 'SMA Negeri 1', level: 'SMA', createdAt: new Date().toISOString() },
      [
        { id: 'u-1', email: 'admin@sma1.id', role: 'school_admin', state: 'active', joinedAt: new Date().toISOString() },
        { id: 'u-2', email: 'guru@sma1.id', role: 'teacher', state: 'active', joinedAt: new Date().toISOString() },
      ],
    );
    planRepo.seed(TENANT_A, WS_A, { plan: 'free', generationsUsedThisMonth: 3 });

    // Seed workspace B (tenant berbeda)
    workspaceStore.seed(
      { id: WS_B, tenantId: TENANT_B, name: 'SMK Negeri 2', level: 'SMK', createdAt: new Date().toISOString() },
      [
        { id: 'u-10', email: 'admin@smk2.id', role: 'school_admin', state: 'active', joinedAt: new Date().toISOString() },
      ],
    );
    planRepo.seed(TENANT_B, WS_B, { plan: 'pro', generationsUsedThisMonth: 7 });
  });

  describe('tenant isolation end-to-end', () => {
    it('workspace members tidak terlihat cross-tenant', async () => {
      const app = buildFullApp(workspaceStore, invitationStore, onboardingStore, planRepo);

      // Tenant A coba akses members workspace B
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/${WS_B}/members`,
        headers: { 'x-tenant-id': TENANT_A },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual([]); // tidak ada members karena tenant mismatch
    });

    it('dashboard tidak bocor data cross-tenant', async () => {
      const app = buildFullApp(workspaceStore, invitationStore, onboardingStore, planRepo);

      // Tenant A coba akses dashboard workspace B
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/dashboard?workspaceId=${WS_B}`,
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'school_admin' },
      });

      // Workspace tidak ditemukan di tenant A → error atau memberCount=0
      expect(res.statusCode).toBe(500); // service throws karena workspace tidak ditemukan
    });

    it('billing tidak bocor data cross-tenant', async () => {
      const app = buildFullApp(workspaceStore, invitationStore, onboardingStore, planRepo);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/billing?workspaceId=${WS_B}`,
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'school_admin' },
      });

      expect(res.statusCode).toBe(200);
      // seatCount=0 karena listMembers(TENANT_A, WS_B) kosong
      expect(res.json().data.seatCount).toBe(0);
    });

    it('onboarding terisolasi per user+workspace', async () => {
      const app = buildFullApp(workspaceStore, invitationStore, onboardingStore, planRepo);

      // User A di workspace A complete
      await app.inject({
        method: 'POST',
        url: '/v1/school/onboarding/complete',
        headers: { 'x-user-id': 'u-2', 'x-workspace-id': WS_A },
      });

      // User yang sama di workspace B masih not_started
      const res = await app.inject({
        method: 'GET',
        url: '/v1/school/onboarding/status',
        headers: { 'x-user-id': 'u-2', 'x-workspace-id': WS_B },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe('not_started');
    });
  });

  describe('admin-only routes reject non-admins', () => {
    it('GET /v1/school/dashboard: teacher → 403', async () => {
      const app = buildFullApp(workspaceStore, invitationStore, onboardingStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/dashboard?workspaceId=${WS_A}`,
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'teacher' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('PERMISSION_DENIED');
    });

    it('GET /v1/school/billing: teacher → 403', async () => {
      const app = buildFullApp(workspaceStore, invitationStore, onboardingStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/billing?workspaceId=${WS_A}`,
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'teacher' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('PERMISSION_DENIED');
    });

    it('GET /v1/school/dashboard: subscriber → 403', async () => {
      const app = buildFullApp(workspaceStore, invitationStore, onboardingStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/dashboard?workspaceId=${WS_A}`,
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'subscriber' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('GET /v1/school/billing: subscriber → 403', async () => {
      const app = buildFullApp(workspaceStore, invitationStore, onboardingStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/billing?workspaceId=${WS_A}`,
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'subscriber' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('GET /v1/school/dashboard: school_admin → 200', async () => {
      const app = buildFullApp(workspaceStore, invitationStore, onboardingStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/dashboard?workspaceId=${WS_A}`,
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'school_admin' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('GET /v1/school/billing: school_admin → 200', async () => {
      const app = buildFullApp(workspaceStore, invitationStore, onboardingStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/billing?workspaceId=${WS_A}`,
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'school_admin' },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('invite tokens are single-use (replay protection)', () => {
    it('accept invitation dua kali → kedua kalinya 404', async () => {
      const app = buildFullApp(workspaceStore, invitationStore, onboardingStore, planRepo);

      // Buat invitation
      const inviteRes = await app.inject({
        method: 'POST',
        url: '/v1/invitations',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: WS_A,
          email: 'newteacher@sma1.id',
          role: 'teacher',
          tenantId: TENANT_A,
          createdByUserId: 'u-1',
        }),
      });
      const { token } = inviteRes.json().data;

      // Accept pertama kali
      const accept1 = await app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password: 'Pass123' }),
      });
      expect(accept1.statusCode).toBe(200);

      // Accept kedua kali dengan token yang sama → 404 (invitation sudah accepted)
      const accept2 = await app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password: 'Pass123' }),
      });
      expect(accept2.statusCode).toBe(404);
      expect(accept2.json().error.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('token invalid → 404', async () => {
      const app = buildFullApp(workspaceStore, invitationStore, onboardingStore, planRepo);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'invalid-token-12345678', password: 'Pass123' }),
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('role enforcement across all school endpoints', () => {
    it('onboarding accessible by any authenticated user (no admin gate)', async () => {
      const app = buildFullApp(workspaceStore, invitationStore, onboardingStore, planRepo);

      // Teacher bisa complete onboarding sendiri
      const res = await app.inject({
        method: 'POST',
        url: '/v1/school/onboarding/complete',
        headers: { 'x-user-id': 'u-2', 'x-workspace-id': WS_A },
      });
      expect(res.statusCode).toBe(200);
    });

    it('members list tidak butuh role khusus (hanya tenant-id)', async () => {
      const app = buildFullApp(workspaceStore, invitationStore, onboardingStore, planRepo);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/${WS_A}/members`,
        headers: { 'x-tenant-id': TENANT_A },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.length).toBe(2);
    });
  });
});
