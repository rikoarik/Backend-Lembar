/**
 * B2-01 — Domain types for private source PDF uploads.
 *
 * These are the canonical shapes the application service speaks; the HTTP
 * layer maps from/to OpenAPI, and the persistence layer maps to/from the
 * Drizzle row types.
 */

export type SourceUploadStatus = 'received' | 'verified' | 'rejected' | 'deleted';

export type SourceUploadAuditAction =
  | 'intake'
  | 'magic_check'
  | 'size_check'
  | 'access_grant'
  | 'access_revoke'
  | 'delete_request'
  | 'delete_complete';

export type RedactionClassification = 'public_friendly' | 'user_private' | 'pending_review';

export interface SourceUpload {
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

export interface SourceUploadVersion {
  id: string;
  uploadId: string;
  version: number;
  storageDriver: string;
  contentHash: string;
  redactionClassification: RedactionClassification;
  createdAt: string;
}

export interface SourceUploadAuditEntry {
  uploadId: string;
  workspaceId: string;
  action: SourceUploadAuditAction;
  actorUserId: string | null;
  requestId: string | null;
  success: boolean;
  failureCode: string | null;
  createdAt: string;
}

export interface AuditWriteInput {
  uploadId: string;
  workspaceId: string;
  action: SourceUploadAuditAction;
  actorUserId: string | null;
  requestId: string | null;
  success: boolean;
  failureCode?: string | null;
}

export interface UpsertUploadInput {
  id: string;
  tenantId: string;
  workspaceId: string;
  uploaderUserId: string;
  filenameRedacted: string;
  contentType: string;
  byteSize: number;
  pageCountHint?: number | null;
  magicSignature?: string | null;
  status: SourceUploadStatus;
  failureCode?: string | null;
  currentVersion?: number;
}

export interface InsertVersionInput {
  uploadId: string;
  version: number;
  storageDriver: string;
  storageKey: string;
  contentHash: string;
  redactionClassification: RedactionClassification;
}

export interface SignedAccessIntent {
  uploadId: string;
  workspaceId: string;
  expiresAtEpochMs: number;
  signedUrlFingerprint: string;
}

export interface SourceUploadsStore {
  insertUpload(row: UpsertUploadInput): Promise<SourceUpload>;
  getUploadByIdForWorkspace(
    workspaceId: string,
    uploadId: string,
  ): Promise<SourceUpload | null>;
  listUploadsForWorkspace(
    workspaceId: string,
    options: { limit: number },
  ): Promise<SourceUpload[]>;
  updateUploadStatus(input: {
    id: string;
    workspaceId: string;
    status: SourceUploadStatus;
    failureCode: string | null;
    magicSignature?: string | null;
  }): Promise<SourceUpload>;
  insertVersion(row: InsertVersionInput): Promise<SourceUploadVersion>;
  currentVersionForUpload(
    workspaceId: string,
    uploadId: string,
  ): Promise<SourceUploadVersion | null>;
  appendAudit(row: AuditWriteInput): Promise<SourceUploadAuditEntry>;
  countAuditByUpload(uploadId: string): Promise<number>;
  listAuditByUpload(uploadId: string): Promise<SourceUploadAuditEntry[]>;
}
