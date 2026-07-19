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

export const USER_ROLES = ['superadmin', 'school_admin', 'teacher', 'subscriber'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    slugUnique: uniqueIndex('tenants_slug_unique').on(t.slug),
  }),
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').$type<UserRole>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    tenantEmailUnique: uniqueIndex('users_tenant_email_unique').on(t.tenantId, t.email),
    roleCheck: check(
      'users_role_check',
      sql`${t.role} in ('superadmin','school_admin','teacher','subscriber')`,
    ),
  }),
);

export const schools = pgTable('schools', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  level: text('level').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

export const marketingContent = pgTable(
  'marketing_content',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<'global' | 'page'>().notNull(),
    slug: text('slug').notNull(),
    locale: text('locale').notNull().default('id-ID'),
    currentVersion: integer('current_version').notNull().default(1),
    publishedVersion: integer('published_version'),
    draftPayload: jsonb('draft_payload'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    slugLocaleUnique: uniqueIndex('marketing_content_slug_locale_unique').on(t.slug, t.locale),
    kindCheck: check('marketing_content_kind_check', sql`${t.kind} in ('global','page')`),
  }),
);

export const marketingContentVersions = pgTable(
  'marketing_content_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contentId: uuid('content_id')
      .notNull()
      .references(() => marketingContent.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    payload: jsonb('payload').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    contentVersionUnique: uniqueIndex('marketing_content_versions_content_version_unique').on(
      t.contentId,
      t.version,
    ),
    versionCheck: check('marketing_content_versions_version_check', sql`${t.version} >= 1`),
  }),
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type School = typeof schools.$inferSelect;
export type NewSchool = typeof schools.$inferInsert;
export type MarketingContent = typeof marketingContent.$inferSelect;
export type NewMarketingContent = typeof marketingContent.$inferInsert;
export type MarketingContentVersion = typeof marketingContentVersions.$inferSelect;
export type NewMarketingContentVersion = typeof marketingContentVersions.$inferInsert;
