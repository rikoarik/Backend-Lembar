import { createHash } from 'node:crypto';

import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { Database } from '../../../infrastructure/database/db.js';
import {
  notificationOutbox,
  notificationSendAudit,
  notificationTemplates,
  type NewNotificationOutboxRow,
  type NotificationLocale,
  type NotificationOutboxRow,
  type NotificationSendAuditRow,
  type NotificationTemplate,
} from './schema.js';

export type NotificationDb = Database | NodePgDatabase<Record<string, never>>;

export const SEEDED_NOTIFICATION_TEMPLATES = [
  {
    templateKey: 'auth.recovery',
    locale: 'id-ID',
    version: 1,
    subject: 'Kode pemulihan kata sandi',
    bodyText: 'Gunakan kode {{ code }} untuk memulihkan kata sandi Anda.',
    bodyHtml: null,
  },
  {
    templateKey: 'auth.recovery',
    locale: 'en-US',
    version: 1,
    subject: 'Password recovery code',
    bodyText: 'Use code {{ code }} to recover your password.',
    bodyHtml: null,
  },
  {
    templateKey: 'workspace.invite',
    locale: 'id-ID',
    version: 1,
    subject: 'Undangan ke {{ workspace_name }}',
    bodyText:
      '{{ inviter_name }} mengundang Anda ke {{ workspace_name }}. Terima undangan: {{ accept_url }}',
    bodyHtml: null,
  },
  {
    templateKey: 'workspace.invite',
    locale: 'en-US',
    version: 1,
    subject: 'Invitation to {{ workspace_name }}',
    bodyText:
      '{{ inviter_name }} invited you to {{ workspace_name }}. Accept the invitation: {{ accept_url }}',
    bodyHtml: null,
  },
] as const;

export interface CreateOutboxInput {
  eventId: string;
  templateKey: string;
  locale: string;
  recipientHash: string;
  recipientKind: 'email' | 'sms';
  payloadHash: string;
  payload: Record<string, unknown>;
  visibleAt: Date | null;
}

export interface AuditInput {
  outboxId: string;
  status: 'dispatched' | 'failed';
  redactedRecipient: string;
  redactedSubjectHash: string;
  latencyMs: number;
}

export interface AuditView {
  id: string;
  outboxId: string | null;
  adapter: string;
  status: string;
  redactedRecipient: string;
  redactedSubjectHash: string | null;
  latencyMs: number | null;
  createdAt: Date;
}

export class NotificationRepository {
  constructor(private readonly db: NotificationDb) {}

  async transaction<T>(fn: (repo: NotificationRepository) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(new NotificationRepository(tx as NotificationDb)));
  }

  async seedTemplates(): Promise<void> {
    await this.db
      .insert(notificationTemplates)
      .values([...SEEDED_NOTIFICATION_TEMPLATES])
      .onConflictDoNothing();
  }

  async listTemplates(): Promise<
    Array<Pick<NotificationTemplate, 'templateKey' | 'locale' | 'version' | 'subject'>>
  > {
    return this.db
      .select({
        templateKey: notificationTemplates.templateKey,
        locale: notificationTemplates.locale,
        version: notificationTemplates.version,
        subject: notificationTemplates.subject,
      })
      .from(notificationTemplates)
      .orderBy(notificationTemplates.templateKey, notificationTemplates.locale);
  }

  async listTemplateVariants(templateKey: string): Promise<NotificationTemplate[]> {
    return this.db
      .select()
      .from(notificationTemplates)
      .where(eq(notificationTemplates.templateKey, templateKey))
      .orderBy(notificationTemplates.locale, notificationTemplates.version);
  }

  async findTemplate(templateKey: string, locale: string): Promise<NotificationTemplate | null> {
    const requestedLocale: NotificationLocale = locale === 'en-US' ? 'en-US' : 'id-ID';
    const [preferred] = await this.db
      .select()
      .from(notificationTemplates)
      .where(
        and(
          eq(notificationTemplates.templateKey, templateKey),
          eq(notificationTemplates.locale, requestedLocale),
        ),
      )
      .orderBy(sql`${notificationTemplates.version} desc`)
      .limit(1);
    if (preferred) return preferred;

    const [fallback] = await this.db
      .select()
      .from(notificationTemplates)
      .where(
        and(
          eq(notificationTemplates.templateKey, templateKey),
          eq(notificationTemplates.locale, 'id-ID'),
        ),
      )
      .orderBy(sql`${notificationTemplates.version} desc`)
      .limit(1);
    return fallback ?? null;
  }

  async hasSentDedupe(
    templateKey: string,
    recipientHash: string,
    payloadHash: string,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: notificationOutbox.id })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.templateKey, templateKey),
          eq(notificationOutbox.recipientHash, recipientHash),
          eq(notificationOutbox.payloadHash, payloadHash),
          eq(notificationOutbox.status, 'sent'),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async createOutbox(input: CreateOutboxInput): Promise<NotificationOutboxRow> {
    const values: NewNotificationOutboxRow = {
      eventId: input.eventId,
      templateKey: input.templateKey,
      locale: input.locale === 'en-US' ? 'en-US' : 'id-ID',
      recipientHash: input.recipientHash,
      recipientKind: input.recipientKind,
      payloadHash: input.payloadHash,
      payload: input.payload,
      status: 'pending',
      visibleAt: input.visibleAt,
    };
    const [row] = await this.db.insert(notificationOutbox).values(values).returning();
    if (!row) throw new Error('notification outbox insert returned no row');
    return row;
  }

  async markOutboxSent(outboxId: string): Promise<void> {
    await this.db
      .update(notificationOutbox)
      .set({ status: 'sent', attemptCount: 1, sentAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(notificationOutbox.id, outboxId));
  }

  async insertAudit(input: AuditInput): Promise<NotificationSendAuditRow> {
    const [row] = await this.db
      .insert(notificationSendAudit)
      .values({
        outboxId: input.outboxId,
        adapter: 'memory',
        status: input.status,
        redactedRecipient: input.redactedRecipient,
        redactedSubjectHash: input.redactedSubjectHash,
        latencyMs: input.latencyMs,
      })
      .returning();
    if (!row) throw new Error('notification audit insert returned no row');
    return row;
  }

  async listAudit(limit = 100): Promise<AuditView[]> {
    return this.db
      .select({
        id: notificationSendAudit.id,
        outboxId: notificationSendAudit.outboxId,
        adapter: notificationSendAudit.adapter,
        status: notificationSendAudit.status,
        redactedRecipient: notificationSendAudit.redactedRecipient,
        redactedSubjectHash: notificationSendAudit.redactedSubjectHash,
        latencyMs: notificationSendAudit.latencyMs,
        createdAt: notificationSendAudit.createdAt,
      })
      .from(notificationSendAudit)
      .orderBy(sql`${notificationSendAudit.createdAt} desc`)
      .limit(Math.min(Math.max(limit, 1), 100));
  }

  async countAudit(where?: SQL): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationSendAudit)
      .where(where);
    return row?.count ?? 0;
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
