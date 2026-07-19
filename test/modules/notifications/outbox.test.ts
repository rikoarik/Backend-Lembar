import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  createDatabase,
  getPool,
  type Database,
} from '../../../src/infrastructure/database/db.js';
import {
  notificationOutbox,
  notificationTemplates,
} from '../../../src/modules/notifications/persistence/schema.js';
import { NotificationRepository } from '../../../src/modules/notifications/persistence/NotificationRepository.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..', '..');
const migrationsFolder = path.join(projectRoot, 'src', 'infrastructure', 'database', 'migrations');
const notificationMigrationPath = path.join(migrationsFolder, '0005_notification_outbox.sql');

describeDb('notification outbox constraints', () => {
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

  async function setup(): Promise<Database> {
    const db = createDatabase({ connectionString: DATABASE_URL! });
    dbs.push(db);
    await ensureNotificationTables(db);
    await new NotificationRepository(db).seedTemplates();
    return db;
  }

  it('enforces event_id uniqueness', async () => {
    const db = await setup();
    const eventId = randomUUID();
    await db.insert(notificationOutbox).values({
      eventId,
      templateKey: 'auth.recovery',
      locale: 'id-ID',
      recipientHash: 'a'.repeat(64),
      recipientKind: 'email',
      payloadHash: 'b'.repeat(64),
      payload: { code: '123456' },
      status: 'pending',
    });

    await expect(
      db.insert(notificationOutbox).values({
        eventId,
        templateKey: 'auth.recovery',
        locale: 'id-ID',
        recipientHash: 'c'.repeat(64),
        recipientKind: 'email',
        payloadHash: 'd'.repeat(64),
        payload: { code: '654321' },
        status: 'pending',
      }),
    ).rejects.toThrow();
  });

  it('enforces template key + locale + version uniqueness', async () => {
    const db = await setup();
    await expect(
      db.insert(notificationTemplates).values({
        templateKey: 'auth.recovery',
        locale: 'id-ID',
        version: 1,
        subject: 'dup',
        bodyText: 'dup',
      }),
    ).rejects.toThrow();
  });

  it('rejects invalid outbox status values', async () => {
    const db = await setup();
    await expect(
      db.execute(sql`
        insert into notification_outbox (
          event_id, template_key, locale, recipient_hash, recipient_kind, payload_hash, payload, status
        ) values (
          ${randomUUID()}, 'auth.recovery', 'id-ID', ${'e'.repeat(64)}, 'email', ${'f'.repeat(64)}, '{"code":"123"}'::jsonb, 'in_flight'
        )
      `),
    ).rejects.toThrow();
  });
});
