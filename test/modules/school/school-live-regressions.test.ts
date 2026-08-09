import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const query = vi.fn();
vi.mock('../../../src/infrastructure/database/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/infrastructure/database/db.js')>()),
  getPool: () => ({ query }),
}));

import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';
import { FREE_MONTHLY_LIMIT } from '../../../src/modules/plans/persistence/schema.js';
import { registerSchoolAuditRoutes } from '../../../src/modules/school/adapters/http/schoolAuditRoutes.js';
import { registerSchoolNotificationsRoutes } from '../../../src/modules/school/adapters/http/schoolNotificationsRoutes.js';
import { registerUsageRoutes } from '../../../src/modules/school/adapters/http/usageRoutes.js';
import type { Database } from '../../../src/infrastructure/database/db.js';

const SECRET = 'school-live-regression-secret';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-000000000002';
const db = {} as Database;
const authorization = `Bearer ${generateJwt(
  {
    userId: USER_ID,
    email: 'admin@example.test',
    roles: ['school_admin'],
    workspaceId: WORKSPACE_ID,
  },
  { secret: SECRET, expiryDays: 1 },
)}`;

beforeEach(() => query.mockReset());

describe('school live regressions', () => {
  it('audit treats text metadata without applying JSON operators', async () => {
    query.mockImplementation(async (input: unknown) => {
      const sql = String(input ?? '');
      if (sql.includes('suspended_at')) return { rows: [{ suspended: false }] };
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 0 }] };
      expect(sql).not.toContain('metadata->>');
      return { rows: [] };
    });
    const app = Fastify();
    await registerSchoolAuditRoutes(app, { db, jwtSecret: SECRET });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/school/audit',
      headers: { authorization },
    });
    expect(response.statusCode).toBe(200);
  });

  it('usage uses the same free monthly limit as billing', async () => {
    query.mockImplementation(async (input: unknown) => {
      const sql = String(input ?? '');
      if (sql.includes('suspended_at')) return { rows: [{ suspended: false }] };
      if (sql.includes('SUM(units)')) return { rows: [{ quota_used: '0' }] };
      if (sql.includes('workspace_plans')) return { rows: [{ plan: 'free' }] };
      return { rows: [] };
    });
    const app = Fastify();
    await registerUsageRoutes(app, { db, jwtSecret: SECRET });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/school/usage',
      headers: { authorization },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.quotaLimit).toBe(FREE_MONTHLY_LIMIT);
  });

  it('notifications fail closed when outbox has no workspace_id', async () => {
    query.mockImplementation(async (input: unknown) => {
      const sql = String(input ?? '');
      if (sql.includes('suspended_at')) return { rows: [{ suspended: false }] };
      if (sql.includes('information_schema.tables')) return { rows: [{ exists: true }] };
      if (sql.includes('information_schema.columns')) return { rows: [{ exists: false }] };
      return { rows: [{ count: '1', id: 'global-secret' }] };
    });
    const app = Fastify();
    await registerSchoolNotificationsRoutes(app, { db, jwtSecret: SECRET });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/school/notifications',
      headers: { authorization },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: [], meta: { total: 0 } });
    expect(
      query.mock.calls.some(
        ([sql]) =>
          String(sql).includes('FROM notification_outbox') &&
          !String(sql).includes('information_schema'),
      ),
    ).toBe(false);
  });

  it('notifications enforce suspension through database-backed JWT middleware', async () => {
    query.mockResolvedValue({ rows: [{ suspended: true }] });
    const app = Fastify();
    await registerSchoolNotificationsRoutes(app, { db, jwtSecret: SECRET });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/school/notifications',
      headers: { authorization },
    });
    expect(response.statusCode).not.toBe(200);
    expect(response.json().message).toContain('ditangguhkan');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
