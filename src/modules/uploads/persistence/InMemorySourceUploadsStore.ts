/**
 * B2-01 — In-memory source uploads store.
 *
 * Used by tests/smoke so the B2-01 unit surface can exercise the full
 * service flow without provisioning PostgreSQL. Mirrors the schema shape 1:1.
 */
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

interface MemoryUpload {
  id: string;
  tenantId: string;
  workspaceId: string;
  uploaderUserId: string;
  filenameRedacted: string;
  contentType: string;
  byteSize: number;
  pageCountHint: number | null;
  magicSignature: string | null;
  status: SourceUploadStatus;
  failureCode: string | null;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

interface MemoryVersion {
  id: string;
  uploadId: string;
  version: number;
  storageDriver: string;
  storageKey: string;
  contentHash: string;
  redactionClassification: 'public_friendly' | 'user_private' | 'pending_review';
  createdAt: string;
}

interface MemoryAudit {
  id: string;
  uploadId: string;
  workspaceId: string;
  action: SourceUploadAuditEntry['action'];
  actorUserId: string | null;
  requestId: string | null;
  success: boolean;
  failureCode: string | null;
  createdAt: string;
}

export class InMemorySourceUploadsStore implements SourceUploadsStore {
  private readonly uploads = new Map<string, MemoryUpload>();
  private readonly versions: MemoryVersion[] = [];
  private readonly audits: MemoryAudit[] = [];

  async insertUpload(row: UpsertUploadInput): Promise<SourceUpload> {
    const now = new Date().toISOString();
    const entry: MemoryUpload = {
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
      currentVersion: row.currentVersion ?? 1,
      createdAt: now,
      updatedAt: now,
    };
    this.uploads.set(entry.id, entry);
    return this.toUpload(entry);
  }

  async getUploadByIdForWorkspace(
    workspaceId: string,
    uploadId: string,
  ): Promise<SourceUpload | null> {
    const row = this.uploads.get(uploadId);
    if (!row || row.workspaceId !== workspaceId) return null;
    return this.toUpload(row);
  }

  async listUploadsForWorkspace(
    workspaceId: string,
    options: { limit: number },
  ): Promise<SourceUpload[]> {
    const matching = Array.from(this.uploads.values())
      .filter((row) => row.workspaceId === workspaceId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, options.limit);
    return matching.map((row) => this.toUpload(row));
  }

  async updateUploadStatus(input: {
    id: string;
    workspaceId: string;
    status: SourceUploadStatus;
    failureCode: string | null;
    magicSignature?: string | null;
  }): Promise<SourceUpload> {
    const row = this.uploads.get(input.id);
    if (!row || row.workspaceId !== input.workspaceId) {
      throw new Error('upload not found for workspace');
    }
    row.status = input.status;
    row.failureCode = input.failureCode;
    if (input.magicSignature !== undefined) row.magicSignature = input.magicSignature;
    row.updatedAt = new Date().toISOString();
    return this.toUpload(row);
  }

  async insertVersion(row: InsertVersionInput): Promise<SourceUploadVersion> {
    const entry: MemoryVersion = {
      id: `ver_${Math.random().toString(36).slice(2, 10)}`,
      uploadId: row.uploadId,
      version: row.version,
      storageDriver: row.storageDriver,
      storageKey: row.storageKey,
      contentHash: row.contentHash,
      redactionClassification: row.redactionClassification,
      createdAt: new Date().toISOString(),
    };
    this.versions.push(entry);
    return this.toVersion(entry);
  }

  async currentVersionForUpload(
    workspaceId: string,
    uploadId: string,
  ): Promise<SourceUploadVersion | null> {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.workspaceId !== workspaceId) return null;
    const sorted = this.versions
      .filter((row) => row.uploadId === uploadId)
      .sort((a, b) => b.version - a.version);
    const head = sorted[0];
    return head ? this.toVersion(head) : null;
  }

  async appendAudit(row: AuditWriteInput): Promise<SourceUploadAuditEntry> {
    const entry: MemoryAudit = {
      id: `aud_${Math.random().toString(36).slice(2, 10)}`,
      uploadId: row.uploadId,
      workspaceId: row.workspaceId,
      action: row.action,
      actorUserId: row.actorUserId,
      requestId: row.requestId,
      success: row.success,
      failureCode: row.failureCode ?? null,
      createdAt: new Date().toISOString(),
    };
    this.audits.push(entry);
    return this.toAudit(entry);
  }

  async countAuditByUpload(uploadId: string): Promise<number> {
    return this.audits.filter((row) => row.uploadId === uploadId).length;
  }

  async listAuditByUpload(uploadId: string): Promise<SourceUploadAuditEntry[]> {
    return this.audits
      .filter((row) => row.uploadId === uploadId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((row) => this.toAudit(row));
  }

  private toUpload(row: MemoryUpload): SourceUpload {
    return {
      id: row.id,
      tenantId: row.tenantId,
      workspaceId: row.workspaceId,
      uploaderUserId: row.uploaderUserId,
      filenameRedacted: row.filenameRedacted,
      contentType: row.contentType,
      byteSize: row.byteSize,
      pageCountHint: row.pageCountHint,
      magicSignature: row.magicSignature,
      status: row.status,
      failureCode: row.failureCode,
      currentVersion: row.currentVersion,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toVersion(row: MemoryVersion): SourceUploadVersion {
    return {
      id: row.id,
      uploadId: row.uploadId,
      version: row.version,
      storageDriver: row.storageDriver,
      contentHash: row.contentHash,
      redactionClassification: row.redactionClassification,
      createdAt: row.createdAt,
    };
  }

  private toAudit(row: MemoryAudit): SourceUploadAuditEntry {
    return {
      uploadId: row.uploadId,
      workspaceId: row.workspaceId,
      action: row.action,
      actorUserId: row.actorUserId,
      requestId: row.requestId,
      success: row.success,
      failureCode: row.failureCode,
      createdAt: row.createdAt,
    };
  }
}
