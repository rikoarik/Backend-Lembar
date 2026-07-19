/**
 * B2-01 — PostgreSQL-backed source uploads store.
 *
 * Every read/write is workspace-scoped by construction. The repository layer
 * is the only place that issues SELECT/UPDATE statements against uploads;
 * routes and the application service must go through this class.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { fingerprint } from '../../../common/redact.js';
import type { Database } from '../../../infrastructure/database/db.js';
import {
  sourceUploadAudit,
  sourceUploadVersions,
  sourceUploads,
  type SourceUploadRow,
  type SourceUploadVersionRow,
} from './schema.js';
import type {
  AuditWriteInput,
  InsertVersionInput,
  SourceUpload,
  SourceUploadAuditEntry,
  SourceUploadStatus,
  SourceUploadVersion,
  SourceUploadsStore,
  UpsertUploadInput,
} from '../domain/SourceUpload.js';

export class PostgresSourceUploadsStore implements SourceUploadsStore {
  constructor(private readonly db: Database) {}

  async insertUpload(row: UpsertUploadInput): Promise<SourceUpload> {
    const [inserted] = await this.db
      .insert(sourceUploads)
      .values({
        id: row.id,
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        uploaderUserId: row.uploaderUserId,
        filenameRedacted: row.filenameRedacted,
        contentType: row.contentType,
        byteSize: row.byteSize,
        pageCountHint: row.pageCountHint ?? null,
        magicSignature: row.magicSignature ?? null,
        status: row.status,
        failureCode: row.failureCode ?? null,
      })
      .returning();
    if (!inserted) throw new Error('insertUpload returned no row');
    return this.fromRow(
      {
        ...inserted,
        // Default current_version pointer on the row is implicit; we keep the
        // int 1 default in DB. Read back via separate query is unnecessary here.
      },
      row.currentVersion ?? 1,
    );
  }

  async getUploadByIdForWorkspace(
    workspaceId: string,
    uploadId: string,
  ): Promise<SourceUpload | null> {
    const [row] = await this.db
      .select()
      .from(sourceUploads)
      .where(and(eq(sourceUploads.workspaceId, workspaceId), eq(sourceUploads.id, uploadId)))
      .limit(1);
    if (!row) return null;
    const version = await this.currentVersionForWorkspaceUpload(workspaceId, uploadId);
    return this.fromRow(row, version?.version ?? null);
  }

  async listUploadsForWorkspace(
    workspaceId: string,
    options: { limit: number },
  ): Promise<SourceUpload[]> {
    const rows = await this.db
      .select()
      .from(sourceUploads)
      .where(eq(sourceUploads.workspaceId, workspaceId))
      .orderBy(desc(sourceUploads.createdAt))
      .limit(options.limit);
    if (rows.length === 0) return [];
    const head = rows[0];
    if (!head) return [];
    const versionRows = await this.db
      .select()
      .from(sourceUploadVersions)
      .where(eq(sourceUploadVersions.uploadId, head.id))
      .orderBy(desc(sourceUploadVersions.version));
    const versionsByUpload = new Map<string, SourceUploadVersionRow>();
    for (const v of versionRows) versionsByUpload.set(v.uploadId, v);
    return rows.map((row) => this.fromRow(row, versionsByUpload.get(row.id)?.version ?? 1));
  }

  async updateUploadStatus(input: {
    id: string;
    workspaceId: string;
    status: SourceUploadStatus;
    failureCode: string | null;
    magicSignature?: string | null;
  }): Promise<SourceUpload> {
    const [row] = await this.db
      .update(sourceUploads)
      .set({
        status: input.status,
        failureCode: input.failureCode,
        ...(input.magicSignature !== undefined ? { magicSignature: input.magicSignature } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(sourceUploads.id, input.id), eq(sourceUploads.workspaceId, input.workspaceId)))
      .returning();
    if (!row) throw new Error('updateUploadStatus returned no row');
    const version = await this.currentVersionForWorkspaceUpload(input.workspaceId, input.id);
    return this.fromRow(row, version?.version ?? 1);
  }

  async insertVersion(row: InsertVersionInput): Promise<SourceUploadVersion> {
    const [inserted] = await this.db.insert(sourceUploadVersions).values(row).returning();
    if (!inserted) throw new Error('insertVersion returned no row');
    return this.versionFromRow(inserted);
  }

  async currentVersionForUpload(
    workspaceId: string,
    uploadId: string,
  ): Promise<SourceUploadVersion | null> {
    const row = await this.currentVersionForWorkspaceUpload(workspaceId, uploadId);
    return row ? this.versionFromRow(row) : null;
  }

  async appendAudit(row: AuditWriteInput): Promise<SourceUploadAuditEntry> {
    const [inserted] = await this.db
      .insert(sourceUploadAudit)
      .values({
        uploadId: row.uploadId,
        workspaceId: row.workspaceId,
        action: row.action,
        actorUserId: row.actorUserId,
        requestId: row.requestId,
        success: row.success ? 'true' : 'false',
        failureCode: row.failureCode ?? null,
      })
      .returning();
    if (!inserted) throw new Error('appendAudit returned no row');
    return this.auditFromRow(inserted);
  }

  async countAuditByUpload(uploadId: string): Promise<number> {
    const [result] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(sourceUploadAudit)
      .where(eq(sourceUploadAudit.uploadId, uploadId));
    return result?.count ?? 0;
  }

  async listAuditByUpload(uploadId: string): Promise<SourceUploadAuditEntry[]> {
    const rows = await this.db
      .select()
      .from(sourceUploadAudit)
      .where(eq(sourceUploadAudit.uploadId, uploadId))
      .orderBy(asc(sourceUploadAudit.createdAt));
    return rows.map((row) => this.auditFromRow(row));
  }

  private async currentVersionForWorkspaceUpload(
    workspaceId: string,
    uploadId: string,
  ): Promise<SourceUploadVersionRow | null> {
    const [row] = await this.db
      .select({
        version: sourceUploadVersions,
        uploadWorkspace: sourceUploads.workspaceId,
      })
      .from(sourceUploadVersions)
      .innerJoin(sourceUploads, eq(sourceUploads.id, sourceUploadVersions.uploadId))
      .where(
        and(
          eq(sourceUploadVersions.uploadId, uploadId),
          eq(sourceUploads.workspaceId, workspaceId),
        ),
      )
      .orderBy(desc(sourceUploadVersions.version))
      .limit(1);
    return row?.version ?? null;
  }

  private fromRow(row: SourceUploadRow, currentVersion: number | null): SourceUpload {
    return {
      id: row.id,
      tenantId: row.tenantId,
      workspaceId: row.workspaceId,
      uploaderUserId: row.uploaderUserId,
      filenameRedacted: row.filenameRedacted,
      contentType: row.contentType,
      byteSize: row.byteSize,
      pageCountHint: row.pageCountHint ?? null,
      magicSignature: row.magicSignature,
      status: row.status,
      failureCode: row.failureCode,
      currentVersion: currentVersion ?? 1,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private versionFromRow(row: SourceUploadVersionRow): SourceUploadVersion {
    return {
      id: row.id,
      uploadId: row.uploadId,
      version: row.version,
      storageDriver: row.storageDriver,
      contentHash: row.contentHash,
      redactionClassification: row.redactionClassification,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private auditFromRow(row: typeof sourceUploadAudit.$inferSelect): SourceUploadAuditEntry {
    return {
      uploadId: row.uploadId,
      workspaceId: row.workspaceId,
      action: row.action,
      actorUserId: row.actorUserId ?? null,
      requestId: row.requestId ?? null,
      success: row.success === 'true',
      failureCode: row.failureCode ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

// ponytail: when worker-side extraction forks on storage_key it must use the
// helper exported alongside the storage adapter, not re-derive a path. Tracked
// in B2-02 ADR when extraction lands.
export function storageKeyFingerprint(key: string): string {
  return fingerprint(key);
}
