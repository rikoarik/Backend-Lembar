/**
 * Admin ops schema — feature flags, prompts, quality reports, audit trail, billing.
 */
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const adminFlags = pgTable('admin_flags', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  description: text('description').notNull().default(''),
  enabled: text('enabled').notNull().default('false'),
  scope: text('scope').notNull().default('global'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().default(new Date()),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().default(new Date()),
});

export const adminPrompts = pgTable('admin_prompts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description').notNull().default(''),
  promptText: text('prompt_text').notNull().default(''),
  version: text('version').notNull().default('v1'),
  status: text('status').notNull().default('draft'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().default(new Date()),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().default(new Date()),
});

export const adminQualityReports = pgTable('admin_quality_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: text('workspace_id').notNull(),
  assessmentVersionId: text('assessment_version_id').notNull().default(''),
  reporter: text('reporter').notNull().default(''),
  reason: text('reason').notNull(),
  status: text('status').notNull().default('open'),
  notes: text('notes').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().default(new Date()),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().default(new Date()),
});

export const adminAudit = pgTable('admin_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorId: text('actor_id').notNull(),
  actorEmail: text('actor_email').notNull().default(''),
  action: text('action').notNull(),
  targetType: text('target_type').notNull().default(''),
  targetId: text('target_id').notNull().default(''),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().default(new Date()),
});

export const adminBilling = pgTable('admin_billing', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: text('tenant_id').notNull(),
  schoolName: text('school_name').notNull(),
  state: text('state').notNull().default('active'),
  seats: text('seats').notNull().default('0'),
  plan: text('plan').notNull().default('free'),
  renewsAt: timestamp('renews_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().default(new Date()),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().default(new Date()),
});

export type AdminFlag = typeof adminFlags.$inferSelect;
export type AdminPrompt = typeof adminPrompts.$inferSelect;
export type AdminQualityReport = typeof adminQualityReports.$inferSelect;
export type AdminAuditEntry = typeof adminAudit.$inferSelect;
export type AdminBillingRow = typeof adminBilling.$inferSelect;
