import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  createDatabase,
  getPool,
  type Database,
} from '../../../src/infrastructure/database/db.js';
import { PostgresAuthStore } from '../../../src/modules/auth/adapters/persistence/PostgresAuthStore.js';
import { AuthService } from '../../../src/modules/auth/application/AuthService.js';
import { notificationOutbox } from '../../../src/modules/notifications/persistence/schema.js';
import {
  MemoryNotificationAdapter,
  type NotificationAdapter,
} from '../../../src/modules/notifications/domain/NotificationAdapter.js';
import { recoveryTokens, schoolInvitations } from '../../../src/modules/auth/persistence/schema.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..', '..');
const migrationsFolder = path.join(projectRoot, 'src', 'infrastructure', 'database', 'migrations');
const notificationMigrationPath = path.join(migrationsFolder, '0005_notification_outbox.sql');
const authMigrationPath = path.join(migrationsFolder, '0006_auth_integration_finalize.sql');

describeDb('auth notification integration', () => {
  const dbs: Database[] = [];

  afterEach(async () => {
    while (dbs.length > 0) {
      const db = dbs.pop();
      if (db) await closeDatabase(db);
    }
  });

  it('recovery request writes auth token and notification outbox rows atomically', async () => {
    const { db, service } = await setup();
    const registered = await service.register({
      email: uniqueEmail('recovery'),
      password: 'passphrase-1',
    });
    const beforeTokens = await db.select().from(recoveryTokens);
    const beforeOutbox = await db.select().from(notificationOutbox);

    await service.requestRecovery({
      email: registered.userId.replace(registered.userId, 'unused@example.test'),
    });
    await service.requestRecovery({ email: await emailFor(db, registered.userId) });

    const afterTokens = await db.select().from(recoveryTokens);
    const afterOutbox = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.templateKey, 'auth.recovery'));

    expect(afterTokens.length - beforeTokens.length).toBe(1);
    expect(
      afterOutbox.length - beforeOutbox.filter((row) => row.templateKey === 'auth.recovery').length,
    ).toBe(1);
  });

  it('invitation create writes invite and notification outbox rows atomically', async () => {
    const { db, service } = await setup();
    const admin = await service.register({ email: uniqueEmail('admin'), password: 'passphrase-1' });
    const beforeInvites = await db.select().from(schoolInvitations);
    const beforeOutbox = await db.select().from(notificationOutbox);

    await service.createSchoolInvitation({
      email: uniqueEmail('invitee'),
      role: 'teacher',
      workspaceId: admin.workspaceId,
      createdByUserId: admin.userId,
    });

    const afterInvites = await db.select().from(schoolInvitations);
    const afterOutbox = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.templateKey, 'workspace.invite'));

    expect(afterInvites.length - beforeInvites.length).toBe(1);
    expect(
      afterOutbox.length -
        beforeOutbox.filter((row) => row.templateKey === 'workspace.invite').length,
    ).toBe(1);
  });

  it('notification failure leaves no outbox residue', async () => {
    const { db } = await setup();
    const service = buildService(db, failingAdapter());
    const admin = await service.register({
      email: uniqueEmail('rollback-admin'),
      password: 'passphrase-1',
    });
    const email = uniqueEmail('rollback-invitee');

    await expect(
      service.createSchoolInvitation({
        email,
        role: 'teacher',
        workspaceId: admin.workspaceId,
        createdByUserId: admin.userId,
      }),
    ).rejects.toThrow('forced notification failure');

    const residue = await db
      .select()
      .from(schoolInvitations)
      .where(eq(schoolInvitations.email, email));
    expect(residue).toHaveLength(0);
  });

  async function setup(): Promise<{ db: Database; service: AuthService }> {
    const db = createDatabase({ connectionString: DATABASE_URL! });
    dbs.push(db);
    await ensureTables(db);
    const service = buildService(db);
    return { db, service };
  }
});

async function ensureTables(db: Database): Promise<void> {
  const pool = getPool(db);
  if (!pool) throw new Error('database handle has no managed pool');
  await pool.query('select pg_advisory_lock(91919)');
  try {
    const existing = (
      await pool.query(
        "select to_regclass('public.notification_templates') as templates, to_regclass('public.notification_outbox') as outbox, to_regclass('public.notification_send_audit') as audit",
      )
    ).rows as Array<{ templates: string | null; outbox: string | null; audit: string | null }>;
    const row = existing[0];
    if (!row?.templates || !row.outbox || !row.audit) {
      const notificationSql = await readFile(notificationMigrationPath, 'utf8');
      for (const statement of notificationSql
        .split('--> statement-breakpoint')
        .map((part) => part.trim())
        .filter(Boolean)) {
        await pool.query(statement);
      }
    }
    const authSql = await readFile(authMigrationPath, 'utf8');
    for (const statement of authSql
      .split('--> statement-breakpoint')
      .map((part) => part.trim())
      .filter(Boolean)) {
      await pool.query(statement);
    }
  } finally {
    await pool.query('select pg_advisory_unlock(91919)');
  }
}

function buildService(
  db: Database,
  notificationAdapter: NotificationAdapter = new MemoryNotificationAdapter(),
): AuthService {
  return new AuthService({
    store: new PostgresAuthStore({ db, notificationAdapter }),
    now: () => new Date('2026-07-19T10:00:00.000Z'),
    sessionIdleMs: 30 * 60 * 1000,
    sessionAbsoluteMs: 8 * 60 * 60 * 1000,
    recoveryTokenTtlMs: 15 * 60 * 1000,
    inviteTokenTtlMs: 60 * 60 * 1000,
    rateLimitWindowMs: 60_000,
    rateLimitMax: 5,
  });
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@example.test`;
}

function failingAdapter(): NotificationAdapter {
  return {
    async send() {
      throw new Error('forced notification failure');
    },
  };
}

async function emailFor(db: Database, userId: string): Promise<string> {
  const rows = await getPool(db)!.query<{ email: string }>(
    'select email from auth_accounts where id = $1',
    [userId],
  );
  const row = rows.rows[0];
  if (!row) throw new Error('auth account missing');
  return row.email;
}
