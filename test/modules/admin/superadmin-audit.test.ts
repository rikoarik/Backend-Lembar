/**
 * B6-03 — Superadmin ops & audit tests.
 *
 * Evidence covered:
 * - 403 when SUPERADMIN_TOKEN missing or wrong
 * - audit trail logged for every admin action
 * - listAccounts / listJobs / listQualityReports return data
 * - setEntitlement transitions plan and logs audit
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';

import { AdminService } from '../../../src/modules/admin/application/AdminService.js';
import { InMemoryAdminAuditStore } from '../../../src/modules/admin/domain/AdminAuditStore.js';
import { registerAdminRoutes } from '../../../src/modules/admin/adapters/http/adminRoutes.js';
import type {
  AdminAccountSummary,
  AdminJobSummary,
  AdminQualityReport,
} from '../../../src/modules/admin/domain/types.js';
import type { AdminDataStore } from '../../../src/modules/admin/application/AdminService.js';

const SUPERADMIN_TOKEN = 'test-superadmin-token-xyz';

// ─── In-memory data store ─────────────────────────────────────────────────────

class InMemoryAdminDataStore implements AdminDataStore {
  accounts: AdminAccountSummary[] = [
    {
      id: 'acc-001',
      email: 'teacher@school.id',
      role: 'teacher',
      workspaceId: 'ws-school-001',
      membershipState: 'active',
      createdAt: new Date().toISOString(),
    },
  ];

  jobs: AdminJobSummary[] = [
    {
      id: 'job-001',
      workspaceId: 'ws-school-001',
      actorId: 'acc-001',
      kind: 'generate_questions',
      status: 'completed',
      attempt: 1,
      createdAt: new Date().toISOString(),
    },
  ];

  reports: AdminQualityReport[] = [
    {
      id: 'qr-001',
      workspaceId: 'ws-school-001',
      assessmentVersionId: 'av-001',
      valid: true,
      issueCount: 0,
      createdAt: new Date().toISOString(),
    },
  ];

  plans = new Map<string, 'free' | 'pro'>([['ws-school-001', 'free']]);

  async listAccounts(): Promise<AdminAccountSummary[]> {
    return [...this.accounts];
  }

  async listJobs(): Promise<AdminJobSummary[]> {
    return [...this.jobs];
  }

  async listQualityReports(): Promise<AdminQualityReport[]> {
    return [...this.reports];
  }

  async setEntitlement(input: { workspaceId: string; plan: 'free' | 'pro' }): Promise<{ workspaceId: string; plan: string }> {
    this.plans.set(input.workspaceId, input.plan);
    return { workspaceId: input.workspaceId, plan: input.plan };
  }
}

// ─── Test setup ───────────────────────────────────────────────────────────────

async function buildApp(superadminToken: string = SUPERADMIN_TOKEN) {
  const dataStore = new InMemoryAdminDataStore();
  const auditStore = new InMemoryAdminAuditStore();
  const service = new AdminService(dataStore, auditStore);

  const app = Fastify({ logger: false });
  await app.register((instance) =>
    registerAdminRoutes(instance, { service, superadminToken }),
  );
  await app.ready();
  return { app, auditStore, dataStore };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('B6-03 — Superadmin ops & audit', () => {
  // ─── 403 unauthorized ─────────────────────────────────────────────────────

  describe('Authentication', () => {
    it('returns 403 when Authorization header is missing', async () => {
      const { app } = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/v1/admin/accounts' });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error.code).toBe('PERMISSION_DENIED');
    });

    it('returns 403 when token is wrong', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/accounts',
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 with non-Bearer scheme', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/accounts',
        headers: { authorization: `Basic ${SUPERADMIN_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ─── GET /v1/admin/accounts ────────────────────────────────────────────────

  describe('GET /v1/admin/accounts', () => {
    it('returns accounts list with valid token', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/accounts',
        headers: { authorization: `Bearer ${SUPERADMIN_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data[0]).toHaveProperty('email');
    });

    it('logs audit entry for accounts.list', async () => {
      const { app, auditStore } = await buildApp();
      await app.inject({
        method: 'GET',
        url: '/v1/admin/accounts',
        headers: { authorization: `Bearer ${SUPERADMIN_TOKEN}` },
      });
      const entries = auditStore.getAll();
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0]?.action).toBe('admin.accounts.list');
      expect(entries[0]?.actorId).toBe('superadmin');
    });
  });

  // ─── GET /v1/admin/jobs ───────────────────────────────────────────────────

  describe('GET /v1/admin/jobs', () => {
    it('returns jobs list', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/jobs',
        headers: { authorization: `Bearer ${SUPERADMIN_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('logs audit entry for jobs.list', async () => {
      const { app, auditStore } = await buildApp();
      await app.inject({
        method: 'GET',
        url: '/v1/admin/jobs',
        headers: { authorization: `Bearer ${SUPERADMIN_TOKEN}` },
      });
      const entries = auditStore.getAll();
      expect(entries.some((e) => e.action === 'admin.jobs.list')).toBe(true);
    });
  });

  // ─── GET /v1/admin/quality-reports ───────────────────────────────────────

  describe('GET /v1/admin/quality-reports', () => {
    it('returns quality reports list', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/quality-reports',
        headers: { authorization: `Bearer ${SUPERADMIN_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.data)).toBe(true);
    });
  });

  // ─── POST /v1/admin/entitlements/:workspaceId ─────────────────────────────

  describe('POST /v1/admin/entitlements/:workspaceId', () => {
    it('transitions plan to pro', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/entitlements/ws-school-001',
        headers: {
          authorization: `Bearer ${SUPERADMIN_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ plan: 'pro' }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.plan).toBe('pro');
      expect(body.data.workspaceId).toBe('ws-school-001');
    });

    it('rejects invalid plan value with 400', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/entitlements/ws-001',
        headers: {
          authorization: `Bearer ${SUPERADMIN_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ plan: 'enterprise' }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('logs audit entry for entitlement.set', async () => {
      const { app, auditStore } = await buildApp();
      await app.inject({
        method: 'POST',
        url: '/v1/admin/entitlements/ws-audit-test',
        headers: {
          authorization: `Bearer ${SUPERADMIN_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ plan: 'pro' }),
      });
      const entries = auditStore.getAll();
      const setEntry = entries.find((e) => e.action === 'admin.entitlement.set');
      expect(setEntry).toBeDefined();
      expect(setEntry?.targetId).toBe('ws-audit-test');
      expect(setEntry?.metadata['plan']).toBe('pro');
    });
  });

  // ─── Audit trail ─────────────────────────────────────────────────────────

  describe('Audit trail', () => {
    it('records all actions in order', async () => {
      const { app, auditStore } = await buildApp();
      await app.inject({
        method: 'GET',
        url: '/v1/admin/accounts',
        headers: { authorization: `Bearer ${SUPERADMIN_TOKEN}` },
      });
      await app.inject({
        method: 'GET',
        url: '/v1/admin/jobs',
        headers: { authorization: `Bearer ${SUPERADMIN_TOKEN}` },
      });
      await app.inject({
        method: 'POST',
        url: '/v1/admin/entitlements/ws-x',
        headers: {
          authorization: `Bearer ${SUPERADMIN_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ plan: 'pro' }),
      });

      const entries = auditStore.getAll();
      expect(entries.length).toBe(3);
      expect(entries.map((e) => e.action)).toEqual([
        'admin.accounts.list',
        'admin.jobs.list',
        'admin.entitlement.set',
      ]);
    });
  });
});
