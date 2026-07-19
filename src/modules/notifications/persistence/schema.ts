import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const NOTIFICATION_LOCALES = ['id-ID', 'en-US'] as const;
export type NotificationLocale = (typeof NOTIFICATION_LOCALES)[number];

export const RECIPIENT_KINDS = ['email', 'sms'] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

export const OUTBOX_STATUSES = ['pending', 'sending', 'sent', 'failed'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const AUDIT_STATUSES = ['dispatched', 'failed'] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

export const notificationTemplates = pgTable(
  'notification_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateKey: text('template_key').notNull(),
    locale: text('locale').$type<NotificationLocale>().notNull(),
    version: integer('version').notNull().default(1),
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    bodyHtml: text('body_html'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    keyLocaleVersionUnique: uniqueIndex('notification_templates_key_locale_version_unique').on(
      t.templateKey,
      t.locale,
      t.version,
    ),
  }),
);

export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id').notNull(),
    templateKey: text('template_key').notNull(),
    locale: text('locale').$type<NotificationLocale>().notNull().default('id-ID'),
    recipientHash: text('recipient_hash').notNull(),
    recipientKind: text('recipient_kind').$type<RecipientKind>().notNull(),
    payloadHash: text('payload_hash').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<OutboxStatus>().notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'),
    visibleAt: timestamp('visible_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    eventUnique: uniqueIndex('notification_outbox_event_id_unique').on(t.eventId),
    sentDedupeIdx: uniqueIndex('notification_outbox_sent_dedupe_unique')
      .on(t.templateKey, t.recipientHash, t.payloadHash)
      .where(sql`${t.status} = 'sent'`),
    statusCheck: check(
      'notification_outbox_status_check',
      sql`${t.status} in ('pending','sending','sent','failed')`,
    ),
    recipientKindCheck: check(
      'notification_outbox_recipient_kind_check',
      sql`${t.recipientKind} in ('email','sms')`,
    ),
  }),
);

export const notificationSendAudit = pgTable(
  'notification_send_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    outboxId: uuid('outbox_id').references(() => notificationOutbox.id, { onDelete: 'set null' }),
    adapter: text('adapter').notNull(),
    status: text('status').$type<AuditStatus>().notNull(),
    redactedRecipient: text('redacted_recipient').notNull(),
    redactedSubjectHash: text('redacted_subject_hash'),
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    adapterCheck: check('notification_send_audit_adapter_check', sql`${t.adapter} = 'memory'`),
    statusCheck: check(
      'notification_send_audit_status_check',
      sql`${t.status} in ('dispatched','failed')`,
    ),
  }),
);

export type NotificationTemplate = typeof notificationTemplates.$inferSelect;
export type NewNotificationTemplate = typeof notificationTemplates.$inferInsert;
export type NotificationOutboxRow = typeof notificationOutbox.$inferSelect;
export type NewNotificationOutboxRow = typeof notificationOutbox.$inferInsert;
export type NotificationSendAuditRow = typeof notificationSendAudit.$inferSelect;
export type NewNotificationSendAuditRow = typeof notificationSendAudit.$inferInsert;
