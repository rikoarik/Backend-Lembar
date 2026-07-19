import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, test } from 'vitest';

import {
  closeDatabase,
  createDatabase,
  getPool,
  type Database,
} from '../../../src/infrastructure/database/db.js';
import { InMemoryAuthStore } from '../../../src/modules/auth/adapters/persistence/InMemoryAuthStore.js';
import { PostgresAuthStore } from '../../../src/modules/auth/adapters/persistence/PostgresAuthStore.js';
import { AuthService, type AuthStore } from '../../../src/modules/auth/application/AuthService.js';
import {
  recoveryTokens,
  schoolInvitations,
  sessions,
} from '../../../src/modules/auth/persistence/schema.js';
import { MemoryNotificationAdapter } from '../../../src/modules/notifications/domain/NotificationAdapter.js';
import {
  notificationOutbox,
  notificationSendAudit,
} from '../../../src/modules/notifications/persistence/schema.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..', '..');
const migrationsFolder = path.join(projectRoot, 'src', 'infrastructure', 'database', 'migrations');
const notificationMigrationPath = path.join(migrationsFolder, '0005_notification_outbox.sql');
const authMigrationPath = path.join(migrationsFolder, '0006_auth_integration_finalize.sql');

function buildService(store: AuthStore = new InMemoryAuthStore()): AuthService {
  return new AuthService({
    store,
    now: () => new Date('2026-07-19T10:00:00.000Z'),
    sessionIdleMs: 30 * 60 * 1000,
    sessionAbsoluteMs: 8 * 60 * 60 * 1000,
    recoveryTokenTtlMs: 15 * 60 * 1000,
    inviteTokenTtlMs: 60 * 60 * 1000,
    rateLimitWindowMs: 60_000,
    rateLimitMax: 2,
  });
}

describe('AuthService', () => {
  test('registers a user with personal workspace and uses enumeration-safe duplicate response', async () => {
    const service = buildService();

    const first = await service.register({
      email: ' Teacher@Example.test ',
      password: 'passphrase-1',
    });
    const context = await service.currentContext(
      (await service.login({ email: 'teacher@example.test', password: 'passphrase-1' })).session.id,
    );
    const second = await service.register({
      email: 'teacher@example.test',
      password: 'passphrase-1',
    });

    expect(first.status).toBe('created');
    expect(context).toMatchObject({
      userId: first.userId,
      activeWorkspaceId: first.workspaceId,
      workspaceIds: [first.workspaceId],
    });
    expect(second.status).toBe('accepted');
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.message).toBe(
      'Jika pendaftaran dapat diproses, instruksi berikutnya akan dikirim.',
    );
    expect(await service.auditCount('register')).toBe(1);
  });

  test('repairs existing accounts that are missing personal workspace context', async () => {
    const store = new InMemoryAuthStore();
    await store.saveUser({
      id: randomUUID(),
      email: 'teacher@example.test',
      passwordHash: 'legacy-hash',
      sessionVersion: 1,
      createdAt: new Date('2026-07-18T10:00:00.000Z'),
    });
    const service = buildService(store);

    const result = await service.register({
      email: 'teacher@example.test',
      password: 'passphrase-1',
    });

    expect(result.status).toBe('accepted');
    expect(result.workspaceId).not.toBe(result.userId);
    expect(await store.getMembership(result.userId, result.workspaceId)).toMatchObject({
      state: 'active',
    });
  });

  test('rolls back first account creation when personal workspace membership creation fails', async () => {
    const store = new FailingMembershipStore();
    const service = buildService(store);

    await expect(
      service.register({ email: 'teacher@example.test', password: 'passphrase-1' }),
    ).rejects.toThrow('membership write failed');

    expect(await store.getUserByEmail('teacher@example.test')).toBeNull();
    expect(store.workspaceId).not.toBeNull();
    expect(await store.getWorkspace(store.workspaceId!)).toBeNull();
  });

  test('login rotates session id and logout revokes the session', async () => {
    const service = buildService();
    await service.register({ email: 'teacher@example.test', password: 'passphrase-1' });

    const first = await service.login({ email: 'teacher@example.test', password: 'passphrase-1' });
    const second = await service.login({ email: 'teacher@example.test', password: 'passphrase-1' });
    await service.logout({ sessionId: second.session.id });

    expect(first.session.id).not.toBe(second.session.id);
    await expect(service.requireSession(second.session.id)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    expect(await service.auditCount('login')).toBe(2);
    expect(await service.auditCount('logout')).toBe(1);
  });

  test('recovery is generic, single-use, and revokes older sessions', async () => {
    const store = new InMemoryAuthStore();
    const service = buildService(store);
    await service.register({ email: 'teacher@example.test', password: 'passphrase-1' });
    const before = await service.login({ email: 'teacher@example.test', password: 'passphrase-1' });

    const request = await service.requestRecovery({ email: 'teacher@example.test' });
    const token = store.tokenFromNotification('auth.recovery');
    if (!token) throw new Error('recovery notification token missing');
    const after = await service.completeRecovery({ token, newPassword: 'passphrase-2' });

    expect(request.message).toBe('Jika akun ditemukan, instruksi pemulihan akan dikirim.');
    expect(after.session.id).not.toBe(before.session.id);
    await expect(service.requireSession(before.session.id)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    await expect(
      service.completeRecovery({ token, newPassword: 'passphrase-3' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await service.auditCount('recovery_complete')).toBe(1);
  });

  test('logout all and membership suspension revoke by version check', async () => {
    const service = buildService();
    const registered = await service.register({
      email: 'teacher@example.test',
      password: 'passphrase-1',
    });
    const login = await service.login({ email: 'teacher@example.test', password: 'passphrase-1' });

    await service.logoutAll({ userId: registered.userId });
    await expect(service.requireSession(login.session.id)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });

    const after = await service.login({ email: 'teacher@example.test', password: 'passphrase-1' });
    await service.suspendMembership({
      userId: registered.userId,
      workspaceId: registered.workspaceId,
    });
    await expect(service.requireSession(after.session.id)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    await expect(
      service.switchWorkspace({ sessionId: after.session.id, workspaceId: registered.workspaceId }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  test('school invitation token is hashed, single-use, and replay-rejected', async () => {
    const store = new InMemoryAuthStore();
    const service = buildService(store);
    const admin = await service.register({ email: 'admin@example.test', password: 'passphrase-1' });
    const invite = await service.createSchoolInvitation({
      email: 'teacher@example.test',
      role: 'teacher',
      workspaceId: admin.workspaceId,
      createdByUserId: admin.userId,
    });
    const token = store.tokenFromNotification('workspace.invite');
    if (!token) throw new Error('invite notification token missing');

    const accepted = await service.consumeSchoolInvitation({ token, password: 'passphrase-2' });

    expect(invite.tokenHash).not.toContain(token);
    expect(accepted.workspaceId).toBe(admin.workspaceId);
    await expect(
      service.consumeSchoolInvitation({ token, password: 'passphrase-3' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  test('recovery and invitation create emit notification events', async () => {
    const store = new InMemoryAuthStore();
    const service = buildService(store);
    const admin = await service.register({ email: 'admin@example.test', password: 'passphrase-1' });

    await service.requestRecovery({ email: 'admin@example.test' });
    await service.createSchoolInvitation({
      email: 'teacher@example.test',
      role: 'teacher',
      workspaceId: admin.workspaceId,
      createdByUserId: admin.userId,
    });

    expect(store.notificationCount('auth.recovery')).toBe(1);
    expect(store.notificationCount('workspace.invite')).toBe(1);
    expect(await service.auditCount('recovery_request')).toBe(1);
    expect(await service.auditCount('invitation_create')).toBe(1);
  });

  test('rate limits repeated recovery requests without leaking account existence', async () => {
    const service = buildService();

    await service.requestRecovery({ email: 'missing@example.test' });
    await service.requestRecovery({ email: 'missing@example.test' });

    await expect(service.requestRecovery({ email: 'missing@example.test' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });
});

describeDb('AuthService with Postgres store', () => {
  const dbs: Database[] = [];

  afterEach(async () => {
    while (dbs.length > 0) {
      const db = dbs.pop();
      if (db) await closeDatabase(db);
    }
  });

  test('persists issued login sessions in the DB-backed path', async () => {
    const { db, service } = await setupDb();
    const registered = await service.register({
      email: uniqueEmail('persist'),
      password: 'passphrase-1',
    });

    const login = await service.login({
      email: await emailFor(db, registered.userId),
      password: 'passphrase-1',
    });
    const rows = await db.select().from(sessions).where(eq(sessions.id, login.session.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(registered.workspaceId);
    expect(rows[0]?.state).toBe('active');
  });

  test('recovery request writes token, outbox, and redacted audit rows', async () => {
    const { db, service } = await setupDb();
    const registered = await service.register({
      email: uniqueEmail('recovery-db'),
      password: 'passphrase-1',
    });
    const email = await emailFor(db, registered.userId);
    const beforeTokens = await db.select().from(recoveryTokens);
    const beforeOutbox = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.templateKey, 'auth.recovery'));
    const beforeAudit = await db.select().from(notificationSendAudit);

    await service.requestRecovery({ email });

    const tokenRows = await db.select().from(recoveryTokens);
    const outboxRows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.templateKey, 'auth.recovery'));
    const auditRows = await db.select().from(notificationSendAudit);
    const newAuditRows = auditRows.slice(beforeAudit.length);

    expect(tokenRows.length - beforeTokens.length).toBe(1);
    expect(outboxRows.length - beforeOutbox.length).toBe(1);
    expect(newAuditRows).toHaveLength(1);
    expect(newAuditRows[0]?.redactedRecipient).toBe('email:***@example.test');
    expect(JSON.stringify(newAuditRows[0])).not.toContain(email);
  });

  test('invitation create writes invite, outbox, and redacted audit rows', async () => {
    const { db, service } = await setupDb();
    const admin = await service.register({
      email: uniqueEmail('invite-admin'),
      password: 'passphrase-1',
    });
    const beforeInvites = await db.select().from(schoolInvitations);
    const beforeOutbox = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.templateKey, 'workspace.invite'));
    const beforeAudit = await db.select().from(notificationSendAudit);

    await service.createSchoolInvitation({
      email: uniqueEmail('invitee'),
      role: 'teacher',
      workspaceId: admin.workspaceId,
      createdByUserId: admin.userId,
    });

    const inviteRows = await db.select().from(schoolInvitations);
    const outboxRows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.templateKey, 'workspace.invite'));
    const auditRows = await db.select().from(notificationSendAudit);
    const newAuditRows = auditRows.slice(beforeAudit.length);

    expect(inviteRows.length - beforeInvites.length).toBe(1);
    expect(outboxRows.length - beforeOutbox.length).toBe(1);
    expect(newAuditRows).toHaveLength(1);
    expect(newAuditRows[0]?.redactedRecipient).toBe('email:***@example.test');
  });

  test('logout-all revokes older sessions in the DB-backed path', async () => {
    const { db, service } = await setupDb();
    const registered = await service.register({
      email: uniqueEmail('logout-all'),
      password: 'passphrase-1',
    });
    const email = await emailFor(db, registered.userId);
    const login = await service.login({ email, password: 'passphrase-1' });

    await service.logoutAll({ userId: registered.userId });

    await expect(service.requireSession(login.session.id)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    const rows = await db.select().from(sessions).where(eq(sessions.id, login.session.id));
    expect(rows[0]?.state).toBe('revoked');
  });

  test('workspace switch validates membership in the DB-backed path', async () => {
    const { db, service, store } = await setupDb();
    const registered = await service.register({
      email: uniqueEmail('switch'),
      password: 'passphrase-1',
    });
    const other = await service.register({
      email: uniqueEmail('switch-other'),
      password: 'passphrase-1',
    });
    const email = await emailFor(db, registered.userId);
    const login = await service.login({ email, password: 'passphrase-1' });
    const extraWorkspaceId = randomUUID();

    await store.saveWorkspace({
      id: extraWorkspaceId,
      slug: `school-${extraWorkspaceId.slice(0, 8)}`,
      name: 'Sekolah Uji',
    });
    await store.saveMembership({
      workspaceId: extraWorkspaceId,
      userId: registered.userId,
      role: 'teacher',
      state: 'active',
    });

    const switched = await service.switchWorkspace({
      sessionId: login.session.id,
      workspaceId: extraWorkspaceId,
    });
    const me = await service.currentContext(login.session.id);

    expect(switched.activeWorkspaceId).toBe(extraWorkspaceId);
    expect(me.activeWorkspaceId).toBe(extraWorkspaceId);
    await expect(
      service.switchWorkspace({ sessionId: login.session.id, workspaceId: other.workspaceId }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_ACCESS_DENIED' });
    await expect(
      service.switchWorkspace({ sessionId: login.session.id, workspaceId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_ACCESS_DENIED' });
  });

  test('rolls back first account creation in the DB-backed path when membership creation fails', async () => {
    const db = createDatabase({ connectionString: DATABASE_URL! });
    dbs.push(db);
    await ensureTables(db);
    const store = new FailingMembershipPostgresStore(db);
    const service = new AuthService({
      store,
      now: () => new Date('2026-07-19T10:00:00.000Z'),
      sessionIdleMs: 30 * 60 * 1000,
      sessionAbsoluteMs: 8 * 60 * 60 * 1000,
      recoveryTokenTtlMs: 15 * 60 * 1000,
      inviteTokenTtlMs: 60 * 60 * 1000,
      rateLimitWindowMs: 60_000,
      rateLimitMax: 5,
    });
    const email = uniqueEmail('rollback-db');
    const beforeAccounts = await getPool(db)!.query<{ count: string }>(
      'select count(*)::text as count from auth_accounts where email = $1',
      [email],
    );
    const beforeTenants = await getPool(db)!.query<{ count: string }>(
      "select count(*)::text as count from tenants where slug like 'personal-%'",
    );

    await expect(service.register({ email, password: 'passphrase-1' })).rejects.toThrow(
      'membership write failed',
    );

    const afterAccounts = await getPool(db)!.query<{ count: string }>(
      'select count(*)::text as count from auth_accounts where email = $1',
      [email],
    );
    const afterTenants = await getPool(db)!.query<{ count: string }>(
      "select count(*)::text as count from tenants where slug like 'personal-%'",
    );

    expect(afterAccounts.rows[0]?.count).toBe(beforeAccounts.rows[0]?.count);
    expect(afterTenants.rows[0]?.count).toBe(beforeTenants.rows[0]?.count);
  });

  class FailingMembershipPostgresStore extends PostgresAuthStore {
    constructor(private readonly dbRef: Database) {
      super({ db: dbRef, notificationAdapter: new MemoryNotificationAdapter() });
    }

    override async saveMembership(): Promise<void> {
      throw new Error('membership write failed');
    }

    override async transaction<T>(fn: (store: AuthStore) => Promise<T>): Promise<T> {
      return this.dbRef.transaction(async (tx) =>
        fn(new FailingMembershipPostgresStore(tx as Database)),
      );
    }
  }

  async function setupDb(): Promise<{
    db: Database;
    service: AuthService;
    store: PostgresAuthStore;
  }> {
    const db = createDatabase({ connectionString: DATABASE_URL! });
    dbs.push(db);
    await ensureTables(db);
    const store = new PostgresAuthStore({
      db,
      notificationAdapter: new MemoryNotificationAdapter(),
    });
    const service = new AuthService({
      store,
      now: () => new Date('2026-07-19T10:00:00.000Z'),
      sessionIdleMs: 30 * 60 * 1000,
      sessionAbsoluteMs: 8 * 60 * 60 * 1000,
      recoveryTokenTtlMs: 15 * 60 * 1000,
      inviteTokenTtlMs: 60 * 60 * 1000,
      rateLimitWindowMs: 60_000,
      rateLimitMax: 5,
    });
    return { db, service, store };
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

class FailingMembershipStore extends InMemoryAuthStore {
  workspaceId: string | null = null;

  override async saveWorkspace(
    workspace: Parameters<AuthStore['saveWorkspace']>[0],
  ): Promise<void> {
    this.workspaceId = workspace.id;
    await super.saveWorkspace(workspace);
  }

  override async saveMembership(): Promise<void> {
    throw new Error('membership write failed');
  }
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@example.test`;
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
