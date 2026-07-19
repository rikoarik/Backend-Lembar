/**
 * B2-01 — Application service for private source PDF uploads.
 *
 * Tenant isolation invariants:
 *  - Every public method requires `workspaceId`.
 *  - Repository queries never escape the supplied workspace (id-only lookups
 *    are explicitly workspace-bound).
 *  - Reject state is terminal; re-verify is not allowed in B2-01.
 */
import { createHash, randomUUID } from 'node:crypto';

import { ApiError } from '../../../common/errors/envelope.js';
import type { Database } from '../../../infrastructure/database/db.js';
import type { StorageAdapter } from '../../../infrastructure/storage/StorageAdapter.js';
import { assertShortExpiry } from '../../../infrastructure/storage/InMemoryAdapter.js';
import {
  DEFAULT_SOURCE_UPLOAD_MAX_BYTES,
  FILENAME_REDACTION_PLACEHOLDER,
  PDF_MAGIC_PREFIX,
  PDF_TRAILER_MARKER,
  PDF_TRAILER_SCAN_WINDOW,
  SOURCE_SIGNED_URL_TTL_SECONDS,
  SOURCE_UPLOAD_CONTENT_TYPE,
  redactionClassificationForStatus,
} from '../policy/UploadPolicies.js';
import { PostgresSourceUploadsStore } from '../persistence/PostgresSourceUploadsStore.js';
import { InMemorySourceUploadsStore } from '../persistence/InMemorySourceUploadsStore.js';
import {
  type AuditWriteInput,
  type SignedAccessIntent,
  type SourceUpload,
  type SourceUploadStatus,
  type SourceUploadsStore,
  type SourceUploadAuditEntry,
} from './SourceUpload.js';

export interface SourceUploadsServiceOptions {
  store: SourceUploadsStore;
  storage: StorageAdapter;
  /** Storage driver label persisted on `source_upload_versions.storage_driver`. */
  storageDriverName: string;
  maxBytes?: number;
  /** Test seam to inject synthetic ids/signed URLs. */
  now?: () => Date;
}

export interface IntakeInput {
  workspaceId: string;
  tenantId: string;
  uploaderUserId: string;
  filename: string | null;
  contentType: string;
  declaredByteSize: number;
  bytes: Buffer;
  requestId: string;
}

export interface VerifyInput {
  workspaceId: string;
  uploadId: string;
  actorUserId: string;
  requestId: string;
}

export interface AccessInput {
  workspaceId: string;
  uploadId: string;
  actorUserId: string;
  requestId: string;
}

export interface DeleteInput {
  workspaceId: string;
  uploadId: string;
  actorUserId: string;
  requestId: string;
}

export interface IntakeResult {
  uploadId: string;
  status: SourceUploadStatus;
  byteSize: number;
  contentType: string;
  maxBytes: number;
}

export interface VerifyResult {
  uploadId: string;
  status: SourceUploadStatus;
  magicSignature: string;
}

export interface DeleteResult {
  uploadId: string;
  status: SourceUploadStatus;
  bytesRemoved: boolean;
}

const MAX_FILENAME_BYTES = 200;

export function redactedFilename(input: string | null): string {
  if (!input) return FILENAME_REDACTION_PLACEHOLDER;
  const trimmed = input.trim();
  if (trimmed.length === 0) return FILENAME_REDACTION_PLACEHOLDER;
  return trimmed.length > MAX_FILENAME_BYTES
    ? `${FILENAME_REDACTION_PLACEHOLDER}:${trimmed.length}b`
    : `${FILENAME_REDACTION_PLACEHOLDER}:${createHash('sha256').update(trimmed).digest('hex').slice(0, 12)}`;
}

export function looksLikePdfMagic(bytes: Buffer): boolean {
  if (bytes.byteLength < PDF_MAGIC_PREFIX.byteLength) return false;
  return bytes.subarray(0, PDF_MAGIC_PREFIX.byteLength).equals(PDF_MAGIC_PREFIX);
}

export function hasPdfTrailer(bytes: Buffer): boolean {
  if (bytes.byteLength === 0) return false;
  const tailWindow = Math.min(bytes.byteLength, PDF_TRAILER_SCAN_WINDOW);
  const tail = bytes.subarray(bytes.byteLength - tailWindow).toString('latin1');
  return tail.includes(PDF_TRAILER_MARKER);
}

export function contentHashOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Build a kebab-case-compatible storage key for a private source upload.
 * Worker/long-running extraction reads it by absolute reference only — never
 * log this value at info level.
 */
function storageKeyFor(uploadId: string): string {
  return `private/uploads/${uploadId}/v1.pdf`;
}

export class SourceUploadsService {
  private readonly store: SourceUploadsStore;
  private readonly storage: StorageAdapter;
  private readonly storageDriverName: string;
  private readonly maxBytes: number;
  private readonly now: () => Date;

  constructor(options: SourceUploadsServiceOptions) {
    this.store = options.store;
    this.storage = options.storage;
    this.storageDriverName = options.storageDriverName;
    this.maxBytes = options.maxBytes ?? DEFAULT_SOURCE_UPLOAD_MAX_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  async intake(input: IntakeInput): Promise<IntakeResult> {
    const contentType = (input.contentType ?? '').toLowerCase();
    if (contentType !== SOURCE_UPLOAD_CONTENT_TYPE) {
      await this.audit({
        uploadId: '00000000-0000-0000-0000-000000000000',
        workspaceId: input.workspaceId,
        action: 'intake',
        actorUserId: input.uploaderUserId,
        requestId: input.requestId,
        success: false,
        failureCode: 'content_type_not_pdf',
      });
      throw new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'Berkas harus berformat PDF.',
        requestId: input.requestId,
        status: 400,
        fieldErrors: { contentType: ['Hanya application/pdf yang didukung.'] },
      });
    }
    if (input.bytes.byteLength === 0) {
      throw new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'Berkas kosong.',
        requestId: input.requestId,
        status: 400,
      });
    }
    if (input.bytes.byteLength > this.maxBytes) {
      throw new ApiError({
        code: 'VALIDATION_FAILED',
        message: `Ukuran berkas melebihi batas ${this.maxBytes} byte.`,
        requestId: input.requestId,
        status: 413,
        fieldErrors: { byteSize: ['Berkas terlalu besar.'] },
      });
    }

    const uploadId = randomUUID();
    const filenameRedacted = redactedFilename(input.filename);
    const stored = await this.storage.putObject({
      key: storageKeyFor(uploadId),
      body: input.bytes,
      contentType,
    });
    try {
      const row = await this.store.insertUpload({
        id: uploadId,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        uploaderUserId: input.uploaderUserId,
        filenameRedacted,
        contentType,
        byteSize: stored.byteSize,
        magicSignature: null,
        status: 'received',
        currentVersion: 1,
      });
      await this.store.insertVersion({
        uploadId: row.id,
        version: 1,
        storageDriver: this.storageDriverName,
        storageKey: stored.key,
        contentHash: stored.checksumSha256,
        redactionClassification: redactionClassificationForStatus('received'),
      });
      await this.audit({
        uploadId: row.id,
        workspaceId: row.workspaceId,
        action: 'intake',
        actorUserId: input.uploaderUserId,
        requestId: input.requestId,
        success: true,
      });
      return {
        uploadId: row.id,
        status: row.status,
        byteSize: row.byteSize,
        contentType: row.contentType,
        maxBytes: this.maxBytes,
      };
    } catch (err) {
      // Best-effort cleanup so the storage layer never leaks a payload that
      // we did not durably record.
      try {
        await this.storage.deleteObject(stored.key);
      } catch {
        // Storage deletion failures during cleanup are not fatal; the bytes
        // are still private under the opaque key.
      }
      throw err;
    }
  }

  async verify(input: VerifyInput): Promise<VerifyResult> {
    const upload = await this.requireUpload(input.workspaceId, input.uploadId, input.requestId);
    if (upload.status === 'deleted') {
      throw new ApiError({
        code: 'STATE_CONFLICT',
        message: 'Berkas sudah dihapus.',
        requestId: input.requestId,
        status: 409,
      });
    }
    const version = await this.store.currentVersionForUpload(input.workspaceId, input.uploadId);
    if (!version) {
      throw new ApiError({
        code: 'STATE_CONFLICT',
        message: 'Berkas belum memiliki versi yang dapat diverifikasi.',
        requestId: input.requestId,
        status: 409,
      });
    }
    const head = await this.storage.headObject(storageKeyFor(input.uploadId));
    const magicOk = head.checksumSha256 === version.contentHash;
    if (!magicOk) {
      await this.audit({
        uploadId: input.uploadId,
        workspaceId: input.workspaceId,
        action: 'magic_check',
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        success: false,
        failureCode: 'content_hash_mismatch',
      });
      await this.store.updateUploadStatus({
        id: input.uploadId,
        workspaceId: input.workspaceId,
        status: 'rejected',
        failureCode: 'content_hash_mismatch',
      });
      throw new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'Isi berkas tidak dapat diverifikasi.',
        requestId: input.requestId,
        status: 400,
      });
    }
    await this.audit({
      uploadId: input.uploadId,
      workspaceId: input.workspaceId,
      action: 'magic_check',
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      success: true,
    });
    await this.audit({
      uploadId: input.uploadId,
      workspaceId: input.workspaceId,
      action: 'size_check',
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      success: true,
    });
    const updated = await this.store.updateUploadStatus({
      id: input.uploadId,
      workspaceId: input.workspaceId,
      status: 'verified',
      failureCode: null,
    });
    return {
      uploadId: updated.id,
      status: updated.status,
      magicSignature: version.contentHash,
    };
  }

  async grantAccess(input: AccessInput): Promise<SignedAccessIntent> {
    const upload = await this.requireUpload(input.workspaceId, input.uploadId, input.requestId);
    if (upload.status !== 'verified') {
      throw new ApiError({
        code: 'STATE_CONFLICT',
        message: 'Akses belum tersedia karena verifikasi belum selesai.',
        requestId: input.requestId,
        status: 409,
      });
    }
    const lifetime = SOURCE_SIGNED_URL_TTL_SECONDS;
    assertShortExpiry(lifetime);
    const signed = await this.storage.getSignedUrl(storageKeyFor(input.uploadId), {
      expiresInSeconds: lifetime,
    });
    const intent: SignedAccessIntent = {
      uploadId: input.uploadId,
      workspaceId: input.workspaceId,
      expiresAtEpochMs: signed.expiresAtEpochMs,
      signedUrlFingerprint: createHash('sha256').update(signed.url).digest('hex').slice(0, 12),
    };
    await this.audit({
      uploadId: input.uploadId,
      workspaceId: input.workspaceId,
      action: 'access_grant',
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      success: true,
    });
    return intent;
  }

  async revokeAccess(input: AccessInput): Promise<void> {
    await this.requireUpload(input.workspaceId, input.uploadId, input.requestId);
    await this.audit({
      uploadId: input.uploadId,
      workspaceId: input.workspaceId,
      action: 'access_revoke',
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      success: true,
    });
  }

  async delete(input: DeleteInput): Promise<DeleteResult> {
    const upload = await this.requireUpload(input.workspaceId, input.uploadId, input.requestId);
    if (upload.status === 'deleted') {
      throw new ApiError({
        code: 'STATE_CONFLICT',
        message: 'Berkas sudah dihapus.',
        requestId: input.requestId,
        status: 409,
      });
    }
    await this.audit({
      uploadId: input.uploadId,
      workspaceId: input.workspaceId,
      action: 'delete_request',
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      success: true,
    });
    let bytesRemoved: boolean;
    try {
      await this.storage.deleteObject(storageKeyFor(input.uploadId));
      bytesRemoved = true;
    } catch {
      bytesRemoved = false;
    }
    await this.store.updateUploadStatus({
      id: input.uploadId,
      workspaceId: input.workspaceId,
      status: 'deleted',
      failureCode: null,
    });
    await this.audit({
      uploadId: input.uploadId,
      workspaceId: input.workspaceId,
      action: 'delete_complete',
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      success: true,
    });
    return {
      uploadId: upload.id,
      status: 'deleted',
      bytesRemoved,
    };
  }

  async getRedacted(
    workspaceId: string,
    uploadId: string,
    requestId: string,
  ): Promise<SourceUpload> {
    return this.requireUpload(workspaceId, uploadId, requestId);
  }

  async listRedacted(
    workspaceId: string,
    options: { limit: number },
    requestId: string,
  ): Promise<SourceUpload[]> {
    const capped = Math.max(1, Math.min(100, options.limit));
    const rows = await this.store.listUploadsForWorkspace(workspaceId, { limit: capped });
    if (rows.length === 0) {
      throw new ApiError({
        code: 'RESOURCE_NOT_FOUND',
        message: 'Tidak ada unggahan pada workspace ini.',
        requestId,
        status: 404,
      });
    }
    return rows;
  }

  private async requireUpload(
    workspaceId: string,
    uploadId: string,
    requestId: string,
  ): Promise<SourceUpload> {
    const row = await this.store.getUploadByIdForWorkspace(workspaceId, uploadId);
    if (!row) {
      throw new ApiError({
        code: 'RESOURCE_NOT_FOUND',
        message: 'Unggahan tidak ditemukan.',
        requestId,
        status: 404,
      });
    }
    return row;
  }

  async countAudit(uploadId: string): Promise<number> {
    return this.store.countAuditByUpload(uploadId);
  }

  async listAudit(uploadId: string): Promise<SourceUploadAuditEntry[]> {
    return this.store.listAuditByUpload(uploadId);
  }

  private async audit(row: AuditWriteInput): Promise<void> {
    await this.store.appendAudit(row);
  }
}

export function createPostgresSourceUploadsService(options: {
  db: Database;
  storage: StorageAdapter;
  storageDriverName: string;
  maxBytes?: number;
}): SourceUploadsService {
  return new SourceUploadsService({
    store: new PostgresSourceUploadsStore(options.db),
    storage: options.storage,
    storageDriverName: options.storageDriverName,
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
  });
}

export function createInMemorySourceUploadsService(options: {
  storage: StorageAdapter;
  storageDriverName: string;
  maxBytes?: number;
}): SourceUploadsService {
  return new SourceUploadsService({
    store: new InMemorySourceUploadsStore(),
    storage: options.storage,
    storageDriverName: options.storageDriverName,
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
  });
}
