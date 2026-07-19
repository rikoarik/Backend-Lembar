// Drizzle schema for the auth/session spike. Reuses existing `tenants` and `users`
// tables from the B0-04 baseline (see src/infrastructure/database/schema.ts). This
// file defines the four new tables required by the B0-05 contract:
//   - sessions
//   - recovery_tokens
//   - school_invitations
//   - audit_events
// Schema changes are kept additive so the B0-04 migration remains the only path
// applied at boot; this file is the source of truth for future migrations created
// during B1-01.
//
// Storage/retention policy for these tables will be revisited in B8-02.

import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import {
  tenants,
  users,
  USER_ROLES,
  type UserRole,
} from '../../../infrastructure/database/schema.js';

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

export const sessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    sessionVersion: text('session_version').notNull(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    state: text('state').$type<SessionState>().notNull(),
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
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    state: text('state').$type<RecoveryState>().notNull(),
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
    state: text('state').$type<InvitationState>().notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
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
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
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

export type SessionRow = typeof sessions.$inferSelect;
export type RecoveryTokenRow = typeof recoveryTokens.$inferSelect;
export type SchoolInvitationRow = typeof schoolInvitations.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
