import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  isSafeAnnouncementHref,
  registerAdminRoutes,
} from '../../../src/modules/admin/adapters/http/adminRoutes.js';
import {
  AdminService,
  type AdminDataStore,
} from '../../../src/modules/admin/application/AdminService.js';
import { InMemoryAdminAuditStore } from '../../../src/modules/admin/domain/AdminAuditStore.js';
import type {
  AdminAccountSummary,
  AdminEntitlementInput,
  AdminJobSummary,
  AdminQualityReport,
} from '../../../src/modules/admin/domain/types.js';
import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';
import {
  closeDatabase,
  createDatabase,
  getPool,
  type Database,
} from '../../../src/infrastructure/database/db.js';
import { registerMarketingRoutes } from '../../../src/modules/marketing/adapters/http/routes.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const hasDb = DATABASE_URL.length > 0;
const JWT_SECRET = 'announcement-route-test-secret';
const SUPERADMIN_ID = '00000000-0000-0000-0000-000000000011';
const TEACHER_ID = '00000000-0000-0000-0000-000000000012';
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..', '..');
const migrationsFolder = path.join(projectRoot, 'src', 'infrastructure', 'database', 'migrations');

class StubAdminDataStore implements AdminDataStore {
  async listAccounts(): Promise<AdminAccountSummary[]> {
    return [];
  }

  async listJobs(): Promise<AdminJobSummary[]> {
    return [];
  }

  async listQualityReports(): Promise<AdminQualityReport[]> {
    return [];
  }

  async setEntitlement(
    input: AdminEntitlementInput,
  ): Promise<{ workspaceId: string; plan: string }> {
    return { workspaceId: input.workspaceId, plan: input.plan };
  }
}

function authorization(userId: string, roles: Array<'superadmin' | 'teacher'>): string {
  return `Bearer ${generateJwt(
    {
      userId,
      email: `${roles[0]}@lembar.test`,
      roles,
      workspaceId: null,
    },
    { secret: JWT_SECRET, expiryDays: 1 },
  )}`;
}

describe('announcement CTA URL validation', () => {
  it('accepts local paths and HTTPS URLs only', () => {
    expect(isSafeAnnouncementHref('')).toBe(true);
    expect(isSafeAnnouncementHref('/generator-soal-ai')).toBe(true);
    expect(isSafeAnnouncementHref('https://app.lembar.web.id/harga')).toBe(true);
    expect(isSafeAnnouncementHref('//evil.example')).toBe(false);
    expect(isSafeAnnouncementHref('javascript:alert(1)')).toBe(false);
    expect(isSafeAnnouncementHref('https://user:secret@example.com')).toBe(false);
    expect(isSafeAnnouncementHref('/\\evil.example')).toBe(false);
  });
});

describe.skipIf(!hasDb)('platform announcement routes', () => {
  let db: Database;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = createDatabase({ connectionString: DATABASE_URL });
    await migrate(db, { migrationsFolder });
    const pool = getPool(db);
    if (!pool) throw new Error('Test database pool is unavailable.');
    const announcementMigration = await readFile(
      path.join(migrationsFolder, '0036_platform_announcement.sql'),
      'utf8',
    );
    await pool.query(announcementMigration);

    app = Fastify({ logger: false });
    await registerMarketingRoutes(app, { db });
    await registerAdminRoutes(app, {
      service: new AdminService(new StubAdminDataStore(), new InMemoryAdminAuditStore()),
      db,
      jwtSecret: JWT_SECRET,
    });
    await app.ready();
  });

  beforeEach(async () => {
    const pool = getPool(db);
    if (!pool) throw new Error('Test database pool is unavailable.');
    await pool.query(
      `INSERT INTO jwt_users (id, email, password_hash, name, roles, username)
       VALUES
         ($1, 'announcement-admin@lembar.test', 'not-used', 'Announcement Admin', ARRAY['superadmin'], 'announcement_admin'),
         ($2, 'announcement-teacher@lembar.test', 'not-used', 'Announcement Teacher', ARRAY['teacher'], 'announcement_teacher')
       ON CONFLICT (id) DO UPDATE SET roles = EXCLUDED.roles`,
      [SUPERADMIN_ID, TEACHER_ID],
    );
    await pool.query(
      `UPDATE platform_announcement
          SET enabled = true,
              label = 'Beta',
              message = 'Lembar sedang dalam tahap beta dan terus disempurnakan bersama guru Indonesia.',
              cta_label = 'Mulai mencoba',
              cta_href = '/daftar',
              revision = 1,
              updated_by = NULL,
              updated_at = now()
        WHERE id = 'global'`,
    );
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) await closeDatabase(db);
  });

  it('returns the seeded announcement through the cacheable public endpoint', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/public/announcement' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe(
      'public, max-age=30, stale-while-revalidate=120',
    );
    expect(response.json().data).toMatchObject({
      enabled: true,
      label: 'Beta',
      ctaLabel: 'Mulai mencoba',
      ctaHref: '/daftar',
      revision: 1,
    });
  });

  it('requires a superadmin role for announcement authoring', async () => {
    const unauthenticated = await app.inject({ method: 'GET', url: '/v1/admin/announcement' });
    const teacher = await app.inject({
      method: 'GET',
      url: '/v1/admin/announcement',
      headers: { authorization: authorization(TEACHER_ID, ['teacher']) },
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(teacher.statusCode).toBe(403);
  });

  it('increments revision and rejects a stale update', async () => {
    const headers = {
      authorization: authorization(SUPERADMIN_ID, ['superadmin']),
      'if-match': '1',
    };
    const payload = {
      enabled: true,
      label: 'Info',
      message: 'Fitur review soal baru tersedia untuk dicoba.',
      ctaLabel: 'Pelajari',
      ctaHref: '/generator-soal-ai',
    };
    const updated = await app.inject({
      method: 'PUT',
      url: '/v1/admin/announcement',
      headers,
      payload,
    });
    const stale = await app.inject({
      method: 'PUT',
      url: '/v1/admin/announcement',
      headers,
      payload,
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().data).toMatchObject({ ...payload, revision: 2 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('STATE_CONFLICT');
  });

  it('rejects unsafe CTA URLs', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/admin/announcement',
      headers: {
        authorization: authorization(SUPERADMIN_ID, ['superadmin']),
        'if-match': '1',
      },
      payload: {
        enabled: true,
        label: 'Info',
        message: 'Pesan aman dengan tautan yang tidak aman.',
        ctaLabel: 'Buka',
        ctaHref: '//evil.example/phishing',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});
