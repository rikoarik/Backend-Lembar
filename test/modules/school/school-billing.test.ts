/**
 * B7-04 — School billing tests.
 *
 * Evidence covered:
 * - GET /v1/school/billing returns seat count, plan, usage
 * - Seat count = jumlah active members (filter state='active')
 * - school_admin mendapat 200, role lain 403
 * - Tenant isolation: workspace tenant A tidak terlihat dari tenant B
 * - Plan enforcement: free → monthlyLimit=10, pro → null
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';

import { SchoolBillingService } from '../../../src/modules/school/application/SchoolBillingService.js';
import { registerBillingRoutes } from '../../../src/modules/school/adapters/http/billingRoutes.js';
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TENANT_A = 'tenant-school-a';
const TENANT_B = 'tenant-school-b';
const WS_A = 'ws-alpha';
const WS_B = 'ws-beta';

function buildApp(workspaceStore: StubWorkspaceStore, planRepo: StubPlanRepo) {
  const app = Fastify({ logger: false });
  const billingService = new SchoolBillingService(
    workspaceStore,
    planRepo as unknown as WorkspacePlanRepository,
  );
  void registerBillingRoutes(app, { billingService });
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('B7-04 — School billing', () => {
  let workspaceStore: StubWorkspaceStore;
  let planRepo: StubPlanRepo;

  beforeEach(() => {
    workspaceStore = new StubWorkspaceStore();
    planRepo = new StubPlanRepo();

    // Seed workspace A (3 members: 2 active, 1 inactive)
    workspaceStore.seed(
      { id: WS_A, tenantId: TENANT_A, name: 'SMA Negeri 1', level: 'SMA', createdAt: new Date().toISOString() },
      [
        { id: 'u-1', email: 'admin@sma1.id', role: 'school_admin', state: 'active', joinedAt: new Date().toISOString() },
        { id: 'u-2', email: 'guru@sma1.id', role: 'teacher', state: 'active', joinedAt: new Date().toISOString() },
        { id: 'u-3', email: 'nonaktif@sma1.id', role: 'teacher', state: 'inactive', joinedAt: new Date().toISOString() },
      ],
    );
    planRepo.seed(TENANT_A, WS_A, { plan: 'free', generationsUsedThisMonth: 5 });

    // Seed workspace B (pro plan, 4 active members)
    workspaceStore.seed(
      { id: WS_B, tenantId: TENANT_B, name: 'SMK Negeri 2', level: 'SMK', createdAt: new Date().toISOString() },
      [
        { id: 'u-10', email: 'admin@smk2.id', role: 'school_admin', state: 'active', joinedAt: new Date().toISOString() },
        { id: 'u-11', email: 'guru1@smk2.id', role: 'teacher', state: 'active', joinedAt: new Date().toISOString() },
        { id: 'u-12', email: 'guru2@smk2.id', role: 'teacher', state: 'active', joinedAt: new Date().toISOString() },
        { id: 'u-13', email: 'guru3@smk2.id', role: 'teacher', state: 'active', joinedAt: new Date().toISOString() },
      ],
    );
    planRepo.seed(TENANT_B, WS_B, { plan: 'pro', generationsUsedThisMonth: 42 });
  });

  describe('seat count accuracy', () => {
    it('hanya hitung member dengan state=active', async () => {
      const app = buildApp(workspaceStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/billing?workspaceId=${WS_A}`,
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'school_admin' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.seatCount).toBe(2); // u-1, u-2 active; u-3 inactive
    });

    it('workspace dengan 4 active members → seatCount=4', async () => {
      const app = buildApp(workspaceStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/billing?workspaceId=${WS_B}`,
        headers: { 'x-tenant-id': TENANT_B, 'x-user-role': 'school_admin' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.seatCount).toBe(4);
    });
  });

  describe('plan enforcement', () => {
    it('free plan → monthlyLimit=10', async () => {
      const app = buildApp(workspaceStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/billing?workspaceId=${WS_A}`,
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'school_admin' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.plan).toBe('free');
      expect(body.data.monthlyLimit).toBe(10);
      expect(body.data.generationsUsedThisMonth).toBe(5);
    });

    it('pro plan → monthlyLimit=null (unlimited)', async () => {
      const app = buildApp(workspaceStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/billing?workspaceId=${WS_B}`,
        headers: { 'x-tenant-id': TENANT_B, 'x-user-role': 'school_admin' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.plan).toBe('pro');
      expect(body.data.monthlyLimit).toBeNull();
      expect(body.data.generationsUsedThisMonth).toBe(42);
    });
  });

  describe('akses role', () => {
    it('school_admin mendapat 200', async () => {
      const app = buildApp(workspaceStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/billing?workspaceId=${WS_A}`,
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'school_admin' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('teacher mendapat 403', async () => {
      const app = buildApp(workspaceStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/billing?workspaceId=${WS_A}`,
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'teacher' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('PERMISSION_DENIED');
    });

    it('subscriber mendapat 403', async () => {
      const app = buildApp(workspaceStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/billing?workspaceId=${WS_A}`,
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'subscriber' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('tenant isolation', () => {
    it('tenant A tidak bisa lihat workspace tenant B', async () => {
      const app = buildApp(workspaceStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/billing?workspaceId=${WS_B}`,
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'school_admin' },
      });

      // listMembers(TENANT_A, WS_B) returns empty → seatCount=0 atau error jika workspace null
      expect(res.statusCode).toBe(200);
      expect(res.json().data.seatCount).toBe(0); // no members found for TENANT_A + WS_B
    });
  });

  describe('validasi input', () => {
    it('tanpa workspaceId → 400', async () => {
      const app = buildApp(workspaceStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/school/billing',
        headers: { 'x-tenant-id': TENANT_A, 'x-user-role': 'school_admin' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    });

    it('tanpa x-tenant-id → 400', async () => {
      const app = buildApp(workspaceStore, planRepo);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/school/billing?workspaceId=${WS_A}`,
        headers: { 'x-user-role': 'school_admin' },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
