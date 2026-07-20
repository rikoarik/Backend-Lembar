/**
 * B2-01 — Private source PDF upload persistence schema.
 *
 * Three additive tables, no FK back to the cross-module `tenants` table so this
 * schema loads in isolation (matches the curriculum/marketing convention):
 *
 * - `source_uploads` — one row per private PDF intake. Holds redacted metadata
 *   only. The actual bytes live behind the B0-07 `StorageAdapter`; no signed
 *   URL, storage key, or byte payload is stored on this row.
 * - `source_upload_versions` — immutable version chain per upload (current row
 *   is the latest verified bytes that future B2-02 extraction will read).
 * - `source_upload_audit` — append-only audit of every state transition.
 *
 *  - Status enum matches the contract: `received | verified | rejected | deleted`.
 *  - Tenant isolation: every read must filter by `workspace_id` at the
 *    repository layer; no `findById` without a workspace.
 *  - No production secret is required to migrate or run locally.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const SOURCE_UPLOAD_STATUSES = ['received', 'verified', 'rejected', 'deleted'] as const;
export type SourceUploadStatusDb = (typeof SOURCE_UPLOAD_STATUSES)[number];

export const REDACTION_CLASSIFICATIONS = [
  'public_friendly',
  'user_private',
  'pending_review',
] as const;
export type RedactionClassificationDb = (typeof REDACTION_CLASSIFICATIONS)[number];

export const SOURCE_UPLOAD_AUDIT_ACTIONS = [
  'intake',
  'magic_check',
  'size_check',
  'access_grant',
  'access_revoke',
  'delete_request',
  'delete_complete',
] as const;
export type SourceUploadAuditActionDb = (typeof SOURCE_UPLOAD_AUDIT_ACTIONS)[number];

export const sourceUploads = pgTable(
  'source_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    uploaderUserId: uuid('uploader_user_id').notNull(),
    filenameRedacted: text('filename_redacted').notNull(),
    contentType: text('content_type').notNull().default('application/pdf'),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    pageCountHint: integer('page_count_hint'),
    magicSignature: text('magic_signature'),
    status: text('status').$type<SourceUploadStatusDb>().notNull().default('received'),
    failureCode: text('failure_code'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    workspaceIdx: index('source_uploads_workspace_idx').on(t.workspaceId),
    workspaceStatusIdx: index('source_uploads_workspace_status_idx').on(t.workspaceId, t.status),
    statusCheck: check(
      'source_uploads_status_check',
      sql`${t.status} in ('received','verified','rejected','deleted')`,
    ),
  }),
);

export const sourceUploadVersions = pgTable(
  'source_upload_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    uploadId: uuid('upload_id')
      .notNull()
      .references(() => sourceUploads.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    storageDriver: text('storage_driver').notNull(),
    storageKey: text('storage_key').notNull(),
    contentHash: text('content_hash').notNull(),
    redactionClassification: text('redaction_classification')
      .$type<RedactionClassificationDb>()
      .notNull()
      .default('user_private'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    uploadVersionUnique: uniqueIndex('source_upload_versions_upload_version_unique').on(
      t.uploadId,
      t.version,
    ),
    versionCheck: check('source_upload_versions_version_check', sql`${t.version} >= 1`),
    redactionCheck: check(
      'source_upload_versions_redaction_check',
      sql`${t.redactionClassification} in ('public_friendly','user_private','pending_review')`,
    ),
  }),
);

export const sourceUploadAudit = pgTable(
  'source_upload_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    uploadId: uuid('upload_id')
      .notNull()
      .references(() => sourceUploads.id, { onDelete: 'cascade' }),
    action: text('action').$type<SourceUploadAuditActionDb>().notNull(),
    actorUserId: uuid('actor_user_id'),
    requestId: text('request_id'),
    workspaceId: uuid('workspace_id').notNull(),
    success: text('success').$type<'true' | 'false'>().notNull(),
    failureCode: text('failure_code'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    uploadIdx: index('source_upload_audit_upload_idx').on(t.uploadId),
    workspaceActionIdx: index('source_upload_audit_workspace_action_idx').on(
      t.workspaceId,
      t.action,
    ),
    actionCheck: check(
      'source_upload_audit_action_check',
      sql`${t.action} in ('intake','magic_check','size_check','access_grant','access_revoke','delete_request','delete_complete')`,
    ),
    successCheck: check('source_upload_audit_success_check', sql`${t.success} in ('true','false')`),
  }),
);

export type SourceUploadRow = typeof sourceUploads.$inferSelect;
export type NewSourceUploadRow = typeof sourceUploads.$inferInsert;
export type SourceUploadVersionRow = typeof sourceUploadVersions.$inferSelect;
export type NewSourceUploadVersionRow = typeof sourceUploadVersions.$inferInsert;
export type SourceUploadAuditRow = typeof sourceUploadAudit.$inferSelect;
export type NewSourceUploadAuditRow = typeof sourceUploadAudit.$inferInsert;
