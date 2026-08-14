import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AdminService } from '../../../src/modules/admin/application/AdminService.js';
import type { AdminDataStore } from '../../../src/modules/admin/application/AdminService.js';
import { registerAdminRoutes } from '../../../src/modules/admin/adapters/http/adminRoutes.js';
import { InMemoryAdminAuditStore } from '../../../src/modules/admin/domain/AdminAuditStore.js';
import { createDatabase, closeDatabase, getPool, type Database } from '../../../src/infrastructure/database/db.js';
import { hashPassword } from '../../../src/modules/auth/infrastructure/password.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const JWT_SECRET = 'admin-login-test-secret';

class StubAdminDataStore implements AdminDataStore {
  async listAccounts() { return []; }
  async listJobs() { return []; }
  async listQualityReports() { return []; }
  async setEntitlement(input: { workspaceId: string; plan: string }) {
    return { workspaceId: input.workspaceId, plan: input.plan };
  }
}

describe.skipIf(!DATABASE_URL)('admin login', () => {
  let db: Database;
  let app: ReturnType<typeof Fastify>;
  const ids: string[] = [];

  beforeAll(async () => {
    db = createDatabase({ connectionString: DATABASE_URL });
    app = Fastify({ logger: false });
    await registerAdminRoutes(app, {
      service: new AdminService(new StubAdminDataStore(), new InMemoryAdminAuditStore()),
      db,
      jwtSecret: JWT_SECRET,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (ids.length) await getPool(db)!.query('DELETE FROM jwt_users WHERE id = ANY($1::uuid[])', [ids]);
    await closeDatabase(db);
  });

  it('issues a superadmin JWT only for a valid superadmin password', async () => {
    const id = randomUUID();
    ids.push(id);
    await getPool(db)!.query(
      `INSERT INTO jwt_users (id, email, username, password_hash, name, roles)
       VALUES ($1, $2, $3, $4, $5, ARRAY['superadmin']::text[])`,
      [id, `${id}@admin-login.test`, `admin_${id.slice(0, 8)}`, await hashPassword('PasswordAdmin1!'), 'Admin Test'],
    );

    const success = await app.inject({
      method: 'POST', url: '/v1/admin/login', payload: { email: `${id}@admin-login.test`, password: 'PasswordAdmin1!' },
    });
    expect(success.statusCode).toBe(200);
    expect(success.json()).toMatchObject({ user: { id, roles: ['superadmin'] } });
    expect(success.json().token).toEqual(expect.any(String));

    const denied = await app.inject({
      method: 'POST', url: '/v1/admin/login', payload: { email: `${id}@admin-login.test`, password: 'wrong' },
    });
    expect(denied.statusCode).toBe(401);
  });
});
