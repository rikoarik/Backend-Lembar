import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  createDatabase,
  getPool,
  type Database,
} from '../../../src/infrastructure/database/db.js';
import {
  MemoryNotificationAdapter,
  canonicalize,
} from '../../../src/modules/notifications/domain/NotificationAdapter.js';
import {
  NotificationService,
  hashRecipient,
} from '../../../src/modules/notifications/domain/NotificationService.js';
import {
  NotificationRepository,
  sha256,
} from '../../../src/modules/notifications/persistence/NotificationRepository.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..', '..');
const migrationsFolder = path.join(projectRoot, 'src', 'infrastructure', 'database', 'migrations');
const notificationMigrationPath = path.join(migrationsFolder, '0005_notification_outbox.sql');

describe('notification adapter helpers', () => {
  it('payload hash is stable across re-serialization', () => {
    const a = { z: 1, a: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }] };
    const b = { list: [{ x: 1, y: 2 }], a: { a: 1, b: 2 }, z: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(sha256(canonicalize(a))).toBe(sha256(canonicalize(b)));
  });

  it('redacts recipient and never stores raw values in hashes', () => {
    const email = 'test-secret@example.test';
    const hash = hashRecipient({ kind: 'email', value: email });
    expect(hash).not.toContain(email);
    expect(hash).toHaveLength(64);
  });
});

describeDb('notification adapter integration', () => {
  const dbs: Database[] = [];

  afterEach(async () => {
    while (dbs.length > 0) {
      const db = dbs.pop();
      if (db) await closeDatabase(db);
    }
  });

  async function ensureNotificationTables(db: Database): Promise<void> {
    const pool = getPool(db);
    if (!pool) throw new Error('database handle has no managed pool');
    await pool.query('select pg_advisory_lock(90909)');
    try {
      const existing = (
        await pool.query(
          "select to_regclass('public.notification_templates') as templates, to_regclass('public.notification_outbox') as outbox, to_regclass('public.notification_send_audit') as audit",
        )
      ).rows as Array<{ templates: string | null; outbox: string | null; audit: string | null }>;
      const row = existing[0];
      if (!row?.templates || !row.outbox || !row.audit) {
        await pool.query(
          'drop table if exists notification_send_audit, notification_outbox, notification_templates cascade',
        );
        const sqlText = await readFile(notificationMigrationPath, 'utf8');
        for (const statement of sqlText
          .split('--> statement-breakpoint')
          .map((part) => part.trim())
          .filter(Boolean)) {
          await pool.query(statement);
        }
      }
    } finally {
      await pool.query('select pg_advisory_unlock(90909)');
    }
  }

  async function setup(): Promise<{
    db: Database;
    repo: NotificationRepository;
    service: NotificationService;
  }> {
    const db = createDatabase({ connectionString: DATABASE_URL! });
    dbs.push(db);
    await ensureNotificationTables(db);
    const repo = new NotificationRepository(db);
    await repo.seedTemplates();
    const service = new NotificationService({
      adapter: new MemoryNotificationAdapter(),
      repository: repo,
    });
    return { db, repo, service };
  }

  it('detects duplicates by template + recipient + payload and ignores eventId', async () => {
    const { repo, service } = await setup();
    const payload = { code: '884412' };
    const recipient = { kind: 'email' as const, value: 'dup@example.test' };

    const before = await repo.countAudit();
    const first = await service.dispatch({
      templateKey: 'auth.recovery',
      locale: 'id-ID',
      recipient,
      payload,
      eventId: randomUUID(),
    });
    const second = await service.dispatch({
      templateKey: 'auth.recovery',
      locale: 'id-ID',
      recipient,
      payload,
      eventId: randomUUID(),
    });

    expect(first.status).toBe('dispatched');
    expect(second.status).toBe('duplicate');
    expect((await repo.countAudit()) - before).toBe(1);
  });

  it('falls back to id-ID when requested locale is missing', async () => {
    const { service } = await setup();
    const result = await service.dispatch({
      templateKey: 'auth.recovery',
      locale: 'en-GB',
      recipient: { kind: 'email', value: 'fallback@example.test' },
      payload: { code: '111222' },
      eventId: randomUUID(),
    });
    expect(result.locale).toBe('id-ID');
  });

  it('rolls back outbox and audit rows on transaction failure', async () => {
    const { repo } = await setup();
    const before = await repo.countAudit();

    await expect(
      repo.transaction(async (txRepo) => {
        const service = new NotificationService({
          adapter: new MemoryNotificationAdapter(),
          repository: txRepo,
        });
        const result = await service.dispatch({
          templateKey: 'auth.recovery',
          locale: 'id-ID',
          recipient: { kind: 'email', value: 'rollback@example.test' },
          payload: { code: '999000' },
          eventId: randomUUID(),
        });
        expect(result.status).toBe('dispatched');
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    expect(await repo.countAudit()).toBe(before);
  });
});
