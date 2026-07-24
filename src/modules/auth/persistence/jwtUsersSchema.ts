// JWT Users schema - simplified auth with multiple roles per user
// Separate from session-based auth tables (auth_accounts, auth_workspace_memberships)

import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenants } from '../../../infrastructure/database/schema.js';

// Reuse USER_ROLES from main schema
export const USER_ROLES = ['superadmin', 'school_admin', 'teacher', 'subscriber'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const jwtUsers = pgTable('jwt_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  username: text('username').notNull().unique(),
  phone: text('phone').unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  roles: text('roles')
    .array()
    .notNull()
    .$type<UserRole[]>()
    .default(sql`ARRAY['subscriber']::text[]`),
  workspaceId: uuid('workspace_id').references(() => tenants.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

export type JwtUser = typeof jwtUsers.$inferSelect;
export type NewJwtUser = typeof jwtUsers.$inferInsert;
