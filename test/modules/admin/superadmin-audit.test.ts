/** Current-contract smoke coverage for superadmin routes. */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';
import { AdminService } from '../../../src/modules/admin/application/AdminService.js';
import { registerAdminRoutes } from '../../../src/modules/admin/adapters/http/adminRoutes.js';
import { InMemoryAdminAuditStore } from '../../../src/modules/admin/domain/AdminAuditStore.js';
import type { AdminDataStore } from '../../../src/modules/admin/application/AdminService.js';
import type {
  AdminAccountSummary,
  AdminEntitlementInput,
  AdminJobSummary,
  AdminQualityReport,
} from '../../../src/modules/admin/domain/types.js';

const JWT_SECRET = 'test-superadmin-token-xyz';
const authorization = `Bearer ${generateJwt(
  { userId: 'superadmin', email: 'superadmin@lembar.test', roles: ['superadmin'], workspaceId: null },
  { secret: JWT_SECRET, expiryDays: 1 },
)}`;

class StubAdminDataStore implements AdminDataStore {
  async listAccounts(): Promise<AdminAccountSummary[]> { return []; }
  async listJobs(): Promise<AdminJobSummary[]> { return []; }
  async listQualityReports(): Promise<AdminQualityReport[]> { return []; }
  async setEntitlement(input: AdminEntitlementInput): Promise<{ workspaceId: string; plan: string }> {
    return { workspaceId: input.workspaceId, plan: input.plan };
  }
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register((instance) => registerAdminRoutes(instance, {
    service: new AdminService(new StubAdminDataStore(), new InMemoryAdminAuditStore()),
    db: {} as never,
    jwtSecret: JWT_SECRET,
  }));
  await app.ready();
  return app;
}

describe('B6-03 — Superadmin ops routes', () => {
  it('returns 401 for missing, invalid, and malformed credentials', async () => {
    const app = await buildApp();
    for (const headers of [{}, { authorization: 'Bearer wrong-token' }, { authorization: `Token ${JWT_SECRET}` }]) {
      const response = await app.inject({ method: 'GET', url: '/v1/admin/accounts', headers });
      expect(response.statusCode).toBe(401);
    }
  });

  it('serves empty account, job, and quality-report lists without a database pool', async () => {
    const app = await buildApp();
    for (const url of ['/v1/admin/accounts', '/v1/admin/jobs', '/v1/admin/quality-reports']) {
      const response = await app.inject({ method: 'GET', url, headers: { authorization } });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual([]);
    }
  });

  it('accepts a valid entitlement transition and rejects an invalid plan', async () => {
    const app = await buildApp();
    const success = await app.inject({
      method: 'POST', url: '/v1/admin/entitlements/ws-school-001',
      headers: { authorization, 'content-type': 'application/json' }, payload: { plan: 'pro' },
    });
    expect(success.statusCode).toBe(200);
    expect(success.json().data).toMatchObject({ workspaceId: 'ws-school-001', plan: 'pro' });

    const invalid = await app.inject({
      method: 'POST', url: '/v1/admin/entitlements/ws-school-001',
      headers: { authorization, 'content-type': 'application/json' }, payload: { plan: 'enterprise' },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
