/**
 * B7-02 — School admin dashboard tests.
 *
 * Evidence covered:
 * - school_admin dapat mengakses GET /v1/school/dashboard
 * - role lain (teacher, subscriber) mendapat 403
 * - tenant isolation: workspaceId milik tenant lain tidak terlihat
 * - shape data: workspace, members, memberCount, usage
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';

import { SchoolDashboardService } from '../../../src/modules/school/application/SchoolDashboardService.js';
import { registerDashboardRoutes } from '../../../src/modules/school/adapters/http/dashboardRoutes.js';
import type { SchoolWorkspaceStore } from '../../../src/modules/school/application/SchoolService.js';
import type { WorkspacePlanRepository } from '../../../src/modules/plans/persistence/repository.js';
import type { SchoolWorkspace, SchoolMember } from '../../../src/modules/school/domain/types.js';
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

class StubPlanRepo {
  private plans = new Map<string, WorkspacePlan>();

  seed(tenantId: string, workspaceId: string, plan: Partial<WorkspacePlan> = {}): void {
    const key = `${tenantId}::${workspaceId}`;
    this.plans.set(key, {
      id: `plan-${Date.now()}`,
      tenantId,
      workspaceId,
      plan: 'free',
      generationsUsedThisMonth: 3,
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TENANT_A = 'tenant-school-a';
const TENANT_B = 'tenant-school-b';
const WS_A = 'ws-alpha';
const WS_B = 'ws-beta';

function buildApp(workspaceStore: StubWorkspaceStore, planRepo: StubPlanRepo) {
  const app = Fastify({ logger: false });
  const dashboardService = new SchoolDashboardService(
    workspaceStore,
    planRepo as unknown as WorkspacePlanRepository,
  );
  void registerDashboardRoutes(app, { dashboardService });
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('B7-02 — School admin dashboard', () => {
  let workspaceStore: StubWorkspaceStore;
  let planRepo: StubPlanRepo;

  beforeEach(() => {
    workspaceStore = new StubWorkspaceStore();
    planRepo = new StubPlanRepo();

    // Seed workspace A dengan 2 member
    workspaceStore.seed(
      { id: WS_A, tenantId: TENANT_A, name: 'SMA Negeri 1', level: 'SMA', createdAt: new Date().toISOString() },
      [
        { id: 'u-1', email: 'admin@sma1.id', role: 'school_admin', state: 'active', joinedAt: new Date().toISOString() },
        { id: 'u-2', email: 'guru@sma1.id', role: 'teacher', state: 'active', joinedAt: new Date().toISOString() },
      ],
    );
    planRepo.seed(TENANT_A, WS_A, { generationsUsedThisMonth: 3, plan: 'free' });

    // Seed workspace B (tenant lain)
    workspaceStore.seed(
      { id: WS_B, tenantId: TENANT_B, name: 'SMK Negeri 2', level: 'SMK', createdAt: new Date().toISOString() },
      [{ id: 'u-3', email: 'admin@smk2.id', role: 'school_admin', state: 'active', joinedAt: new Date().toISOString() }],
    );
    planRepo.seed(TENANT_B, WS_B, { generationsUsedThisMonth: 7, plan: 'pro' });
  });

  describe('akses role', () => {
    it('school_admin mendapat 200 dengan data lengkap', async () => {
      const app = buildApp(workspaceStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/dashboard?workspaceId=${WS_A}`,
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'school_admin' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toBeDefined();
      expect(body.data.workspace.id).toBe(WS_A);
      expect(body.data.workspace.name).toBe('SMA Negeri 1');
      expect(body.data.memberCount).toBe(2);
      expect(Array.isArray(body.data.members)).toBe(true);
      expect(body.data.usage.plan).toBe('free');
      expect(body.data.usage.generationsUsedThisMonth).toBe(3);
      expect(body.data.usage.monthlyLimit).toBe(10); // FREE_MONTHLY_LIMIT
    });

    it('teacher mendapat 403', async () => {
      const app = buildApp(workspaceStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/dashboard?workspaceId=${WS_A}`,
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'teacher' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('PERMISSION_DENIED');
    });

    it('subscriber mendapat 403', async () => {
      const app = buildApp(workspaceStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/dashboard?workspaceId=${WS_A}`,
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'subscriber' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('tanpa role header mendapat 403', async () => {
      const app = buildApp(workspaceStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/dashboard?workspaceId=${WS_A}`,
        headers: { 'x-tenant-id': TENANT_A },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('tenant isolation', () => {
    it('school_admin tenant A tidak bisa lihat workspace tenant B', async () => {
      const app = buildApp(workspaceStore, planRepo);

      // Tenant A mencoba akses workspace B — workspace tidak ditemukan karena tenantId berbeda
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/dashboard?workspaceId=${WS_B}`,
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'school_admin' },
      });

      // Service akan throw karena workspace WS_B tidak ada di bawah TENANT_A
      expect(res.statusCode).toBe(500);
    });

    it('school_admin tenant B mendapat data workspace mereka sendiri', async () => {
      const app = buildApp(workspaceStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/dashboard?workspaceId=${WS_B}`,
        headers: { 'x-tenant-id': TENANT_B, 'x-user-role': 'school_admin' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.workspace.tenantId).toBe(TENANT_B);
      expect(body.data.memberCount).toBe(1);
      expect(body.data.usage.plan).toBe('pro');
      expect(body.data.usage.monthlyLimit).toBeNull(); // pro = unlimited
    });
  });

  describe('validasi input', () => {
    it('tanpa workspaceId mendapat 400', async () => {
      const app = buildApp(workspaceStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/school/dashboard',
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'school_admin' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    });

    it('tanpa x-tenant-id mendapat 400', async () => {
      const app = buildApp(workspaceStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/dashboard?workspaceId=${WS_A}`,
        headers: { 'x-user-role': 'school_admin' },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
