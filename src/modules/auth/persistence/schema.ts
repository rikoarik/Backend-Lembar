// Drizzle schema for the integrated auth/session foundation. Reuses `tenants`
// from the B0-04 baseline so workspace IDs stay first-class DB entities,
// while keeping auth-specific state inside additive `auth_*` tables.

import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { tenants, USER_ROLES, type UserRole } from '../../../infrastructure/database/schema.js';

export const MEMBERSHIP_STATES = ['active', 'suspended', 'revoked'] as const;
export type MembershipStateDb = (typeof MEMBERSHIP_STATES)[number];

export const SESSION_STATES = ['active', 'revoked'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const RECOVERY_STATES = ['pending', 'consumed', 'expired'] as const;
export type RecoveryState = (typeof RECOVERY_STATES)[number];

export const INVITATION_STATES = ['pending', 'accepted', 'expired', 'revoked'] as const;
export type InvitationState = (typeof INVITATION_STATES)[number];

export const AUDIT_ACTIONS = [
  'register',
  'login',
  'logout',
  'logout_all',
  'recovery_request',
  'recovery_complete',
  'role_change',
  'membership_suspended',
  'workspace_switch',
  'invitation_create',
  'invitation_accept',
] as const;
export type AuditActionDb = (typeof AUDIT_ACTIONS)[number];

export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    sessionVersion: integer('session_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    emailUnique: uniqueIndex('auth_accounts_email_unique').on(t.email),
  }),
);

export const authWorkspaceMemberships = pgTable(
  'auth_workspace_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => authAccounts.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    role: text('role').$type<UserRole>().notNull(),
    state: text('state').$type<MembershipStateDb>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    accountTenantUnique: uniqueIndex('auth_workspace_memberships_account_tenant_unique').on(
      t.accountId,
      t.tenantId,
    ),
    roleCheck: check(
      'auth_workspace_memberships_role_check',
      sql`${t.role} in (${sql.raw(USER_ROLES.map((role) => `'${role}'`).join(','))})`,
    ),
    stateCheck: check(
      'auth_workspace_memberships_state_check',
      sql`${t.state} in ('active','suspended','revoked')`,
    ),
  }),
);

export const sessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authAccounts.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    sessionVersion: integer('session_version').notNull(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    state: text('state').$type<SessionState>().notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    userIdx: uniqueIndex('auth_sessions_user_id_idx').on(t.userId, t.id),
    stateCheck: check('auth_sessions_state_check', sql`${t.state} in ('active','revoked')`),
  }),
);

export const recoveryTokens = pgTable(
  'auth_recovery_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authAccounts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    state: text('state').$type<RecoveryState>().notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex('auth_recovery_tokens_hash_unique').on(t.tokenHash),
    stateCheck: check(
      'auth_recovery_tokens_state_check',
      sql`${t.state} in ('pending','consumed','expired')`,
    ),
  }),
);

export const schoolInvitations = pgTable(
  'auth_school_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').$type<UserRole>().notNull(),
    state: text('state').$type<InvitationState>().notNull().default('pending'),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    acceptedBy: uuid('accepted_by').references(() => authAccounts.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex('auth_school_invitations_hash_unique').on(t.tokenHash),
    roleCheck: check(
      'auth_school_invitations_role_check',
      sql`${t.role} in (${sql.raw(USER_ROLES.map((role) => `'${role}'`).join(','))})`,
    ),
    stateCheck: check(
      'auth_school_invitations_state_check',
      sql`${t.state} in ('pending','accepted','expired','revoked')`,
    ),
  }),
);

export const auditEvents = pgTable(
  'auth_audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    action: text('action').$type<AuditActionDb>().notNull(),
    userId: uuid('user_id').references(() => authAccounts.id, { onDelete: 'set null' }),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    metadata: text('metadata'),
  },
  (t) => ({
    actionIdx: uniqueIndex('auth_audit_events_action_idx').on(t.action, t.id),
    actionCheck: check(
      'auth_audit_events_action_check',
      sql`${t.action} in (${sql.raw(AUDIT_ACTIONS.map((action) => `'${action}'`).join(','))})`,
    ),
  }),
);

export const rateLimits = pgTable('auth_rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true, mode: 'date' }).notNull(),
});

export type AuthAccountRow = typeof authAccounts.$inferSelect;
export type AuthWorkspaceMembershipRow = typeof authWorkspaceMemberships.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type RecoveryTokenRow = typeof recoveryTokens.$inferSelect;
export type SchoolInvitationRow = typeof schoolInvitations.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type RateLimitRow = typeof rateLimits.$inferSelect;
