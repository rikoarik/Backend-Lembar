import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { parseDatabaseEnv } from '../config/database.env.js';
import { ConfigError, formatConfigError } from '../config/errors.js';
import {
  closeDatabase,
  createDatabase,
  getPool,
  type Database,
} from '../infrastructure/database/db.js';
import { MemoryNotificationAdapter } from '../modules/notifications/domain/NotificationAdapter.js';
import { NotificationService } from '../modules/notifications/domain/NotificationService.js';
import { NotificationRepository } from '../modules/notifications/persistence/NotificationRepository.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const migrationsFolder = path.join(projectRoot, 'src', 'infrastructure', 'database', 'migrations');
const notificationMigrationPath = path.join(migrationsFolder, '0005_notification_outbox.sql');

interface SmokeSummary {
  status: 'ok' | 'error';
  mode: 'single' | 'duplicate';
  migrations: { folder: string; applied: boolean };
  dispatch: { eventId: string; status: string; locale: string };
  audit: { count: number; redactedRecipient?: string; subjectHash?: string };
  duplicate?: { status: string; auditDelta: number };
  redaction: {
    recipientFingerprint: string;
    subjectFingerprint: string;
  };
}

async function loadDb(): Promise<Database> {
  let env;
  try {
    env = parseDatabaseEnv(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${formatConfigError(err.issues)}\n`);
      process.exit(1);
    }
    throw err;
  }
  const url = env.url ?? 'postgres://lembar@127.0.0.1:55443/lembar';
  return createDatabase({
    connectionString: url,
    poolMax: env.poolMax,
    ssl: env.sslMode === 'require',
  });
}

function buildService(db: Database): {
  service: NotificationService;
  repository: NotificationRepository;
} {
  const repository = new NotificationRepository(db);
  const adapter = new MemoryNotificationAdapter();
  return {
    service: new NotificationService({ adapter, repository }),
    repository,
  };
}

async function ensureNotificationTables(db: Database): Promise<void> {
  const pool = getPool(db);
  if (!pool) throw new Error('database handle has no managed pool');
  const existing = (
    await pool.query(
      "select to_regclass('public.notification_templates') as templates, to_regclass('public.notification_outbox') as outbox, to_regclass('public.notification_send_audit') as audit",
    )
  ).rows as Array<{ templates: string | null; outbox: string | null; audit: string | null }>;
  const row = existing[0];
  if (row?.templates && row.outbox && row.audit) return;
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

async function main(): Promise<void> {
  const mode: SmokeSummary['mode'] = process.argv[2] === 'duplicate' ? 'duplicate' : 'single';
  const db = await loadDb();
  const summary: Partial<SmokeSummary> = { mode };
  try {
    try {
      await migrate(db, { migrationsFolder });
    } catch (err) {
      if (!isDuplicateSchemaError(err)) throw err;
    }
    await ensureNotificationTables(db);
    summary.migrations = { folder: migrationsFolder, applied: true };

    const { service, repository } = buildService(db);
    await repository.seedTemplates();

    const eventId = randomUUID();
    const runId = eventId.slice(0, 8);
    const input = {
      templateKey: mode === 'duplicate' ? 'workspace.invite' : 'auth.recovery',
      locale: 'id-ID',
      recipient: {
        kind: 'email' as const,
        value:
          mode === 'duplicate'
            ? `smoke-dedupe-${runId}@example.test`
            : `smoke-recovery-${runId}@example.test`,
      },
      payload:
        mode === 'duplicate'
          ? {
              workspace_name: `Tim Kurikulum ${runId}`,
              inviter_name: 'Bu Rini',
              accept_url: `https://lembar.test/accept/${runId}`,
            }
          : { code: runId },
      eventId,
    };

    const before = await repository.countAudit();
    const result = await service.dispatch(input);
    const afterFirst = await repository.countAudit();

    summary.dispatch = { eventId, status: result.status, locale: result.locale };
    const audit = await repository.listAudit(1);
    const top = audit[0];
    if (!top) throw new Error('expected one audit row after dispatch');
    summary.audit = {
      count: afterFirst,
      redactedRecipient: top.redactedRecipient,
      subjectHash: top.redactedSubjectHash ?? '',
    };
    summary.redaction = {
      recipientFingerprint: result.redactedRecipient,
      subjectFingerprint: result.subjectHash,
    };

    if (mode === 'duplicate') {
      const duplicate = await service.dispatch(input);
      const afterSecond = await repository.countAudit();
      summary.duplicate = { status: duplicate.status, auditDelta: afterSecond - afterFirst };
      if (result.status !== 'dispatched') throw new Error(`first status=${result.status}`);
      if (duplicate.status !== 'duplicate') throw new Error(`duplicate status=${duplicate.status}`);
      if (afterSecond - before !== 1) throw new Error(`audit growth=${afterSecond - before}`);
    }

    summary.status = 'ok';
  } catch (err) {
    summary.status = 'error';
    const message = err instanceof Error ? err.message : 'unknown smoke failure';
    process.stderr.write(`${JSON.stringify({ ...summary, error: { message } })}\n`);
    process.exit(1);
  } finally {
    await closeDatabase(db);
  }

  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

function isDuplicateSchemaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('duplicate key value violates unique constraint');
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('smoke/notification.js') === true;

if (isDirectRun) {
  void main();
}
