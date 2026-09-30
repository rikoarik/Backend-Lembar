/**
 * B2-02 — Source ingestion job handler.
 *
 * Implements the full source_ingestion pipeline:
 *   1. verifying_upload — fetch upload record from store; guard deleted/rejected
 *   2. scanning         — fetch raw bytes from storage adapter
 *   3. extracting       — delegate to SourceExtractionService (text extraction)
 *   4. chunking         — passage chunking (inside SourceExtractionService)
 *   5. indexing         — persist passages (inside SourceExtractionService)
 *
 * Dependencies are injected at construction time so the handler can be
 * unit-tested without a real database or storage backend.
 */
import type { JobContext, JobHandler, JobResult } from '../domain/JobHandler.js';
import type { SourceUploadsStore } from '../../../modules/uploads/domain/SourceUpload.js';
import type { StorageAdapter } from '../../storage/StorageAdapter.js';
import type { SourceExtractionService } from '../../../modules/sources/application/SourceExtractionService.js';
import {
  ExtractionError,
  CancelledError,
} from '../../../modules/sources/application/SourceExtractionService.js';

export interface SourceIngestionHandlerDeps {
  uploadsStore: SourceUploadsStore;
  storage: StorageAdapter;
  extractionService: SourceExtractionService;
}

export class SourceIngestionHandler implements JobHandler {
  readonly kind = 'source_ingestion' as const;

  private readonly uploadsStore: SourceUploadsStore;
  private readonly storage: StorageAdapter;
  private readonly extractionService: SourceExtractionService;

  constructor(deps: SourceIngestionHandlerDeps) {
    this.uploadsStore = deps.uploadsStore;
    this.storage = deps.storage;
    this.extractionService = deps.extractionService;
  }

  async handle(context: JobContext): Promise<JobResult> {
    const { jobId, workspaceId, payload, signal } = context;

    const uploadId =
      (payload['sourceId'] as string | undefined) ?? (payload['uploadId'] as string | undefined);

    if (!uploadId) {
      return {
        status: 'failure',
        error: {
          code: 'MISSING_UPLOAD_ID',
          message: 'payload.sourceId or payload.uploadId is required',
        },
      };
    }

    try {
      // Stage: verifying_upload — load upload record and guard bad states
      const upload = await this.uploadsStore.getUploadByIdForWorkspace(workspaceId, uploadId);

      if (!upload) {
        return {
          status: 'failure',
          error: { code: 'UPLOAD_NOT_FOUND', message: `Upload ${uploadId} not found in workspace` },
        };
      }

      if (upload.status === 'deleted') {
        return {
          status: 'failure',
          error: { code: 'UPLOAD_DELETED', message: 'Upload has been deleted; cannot extract' },
        };
      }

      if (upload.status === 'rejected') {
        return {
          status: 'failure',
          error: { code: 'UPLOAD_REJECTED', message: 'Upload was rejected; cannot extract' },
        };
      }

      if (signal.aborted) {
        return { status: 'failure', error: { code: 'CANCELLED', message: 'Job was cancelled' } };
      }

      // Stage: scanning — fetch the raw bytes from storage
      const version = await this.uploadsStore.currentVersionForUpload(workspaceId, uploadId);

      if (!version) {
        return {
          status: 'failure',
          error: { code: 'NO_VERSION', message: 'Upload has no current version; cannot extract' },
        };
      }

      // Stage: scanning — fetch the raw bytes from storage.
      //
      // BUG-19: `StorageAdapter` now exposes `getObject`, so the worker reads
      // the real private object by the storage key recorded on the current
      // version. Previously this fell back to a `[stub]` sentinel buffer, which
      // meant every extracted passage was synthetic regardless of the upload.
      const rawBytes: Buffer = await this.readBytes(payload, version.storageKey);

      // Stage: extracting → chunking → indexing (delegated to SourceExtractionService)
      const result = await this.extractionService.run({
        uploadId,
        workspaceId,
        bytes: rawBytes,
        contentType: upload.contentType,
        signal,
      });

      return {
        status: 'success',
        output: {
          jobId,
          uploadId,
          extractionJobId: result.jobId,
          pageCount: result.pageCount,
          passageCount: result.passageCount,
        },
      };
    } catch (err) {
      if (signal.aborted || err instanceof CancelledError) {
        return { status: 'failure', error: { code: 'CANCELLED', message: 'Job was cancelled' } };
      }

      if (err instanceof ExtractionError) {
        const retryable = isRetryableCode(err.code);
        return {
          status: 'failure',
          error: {
            code: err.code,
            message: err.message,
            details: { retryable },
          },
        };
      }

      return {
        status: 'failure',
        error: {
          code: 'PROCESSING_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /**
   * Read the raw bytes for an extraction run.
   *
   * Order of preference:
   * 1. `payload.bytes` — a Buffer/Uint8Array/base64 string. Kept so in-process
   *    smoke paths and unit tests can run without a storage backend.
   * 2. `storage.getObject(version.storageKey)` — the real path: the object the
   *    API wrote when the client PUT the PDF.
   *
   * An empty buffer is returned only when neither source is available, which
   * means a genuinely missing upload; the extractor then fails with
   * EMPTY_UPLOAD rather than silently producing fake passages.
   */
  private async readBytes(
    payload: Record<string, unknown>,
    storageKey: string,
  ): Promise<Buffer> {
    const fromPayload = readBytesFromPayload(payload);
    if (fromPayload) return fromPayload;
    try {
      const object = await this.storage.getObject(storageKey);
      return object.body;
    } catch {
      // Object missing or unreadable — surface it as an empty payload so the
      // extraction pipeline reports a real failure code.
      return Buffer.alloc(0);
    }
  }
}

/** Decode `payload.bytes` when the caller supplied the body inline. */
function readBytesFromPayload(payload: Record<string, unknown>): Buffer | null {
  const raw = payload['bytes'];
  if (raw instanceof Buffer) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (typeof raw === 'string') {
    try {
      return Buffer.from(raw, 'base64');
    } catch {
      return null;
    }
  }
  return null;
}

/** Codes that warrant a retry vs. terminal failure. */
function isRetryableCode(code: string): boolean {
  return ![
    'IMAGE_ONLY_OR_ENCRYPTED',
    'UPLOAD_DELETED',
    'UPLOAD_REJECTED',
    'MISSING_UPLOAD_ID',
  ].includes(code);
}
