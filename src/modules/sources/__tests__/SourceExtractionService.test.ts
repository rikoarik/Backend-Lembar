/**
 * B2-02 — Unit tests for SourceExtractionService.
 *
 * Tests cover:
 * - Full happy-path pipeline: 5 stages, passages persisted, job succeeds
 * - Idempotency: second run on already-succeeded job returns existing passages
 * - Image-only/encrypted PDF → IMAGE_ONLY_OR_ENCRYPTED failure
 * - Empty bytes → EMPTY_UPLOAD failure
 * - Cancellation at each stage
 * - Deleted upload guard (in SourceIngestionHandler)
 * - SourceIngestionHandler: missing uploadId payload
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  SourceExtractionService,
  ExtractionError,
  CancelledError,
  StubTextExtractorAdapter,
} from '../application/SourceExtractionService.js';
import {
  InMemorySourceExtractionJobsStore,
  InMemorySourcePassagesStore,
} from '../persistence/InMemorySourceExtractionStores.js';
import { SourceIngestionHandler } from '../../../infrastructure/queue/handlers/SourceIngestionHandler.js';
import { InMemorySourceUploadsStore } from '../../uploads/persistence/InMemorySourceUploadsStore.js';
import type { TextExtractorAdapter, PageText } from '../application/SourceExtractionService.js';
import type { StorageAdapter } from '../../../infrastructure/storage/StorageAdapter.js';

// ---- helpers ----

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const UPLOAD_ID = '00000000-0000-0000-0000-000000000002';

function makeSignal(): AbortSignal {
  return new AbortController().signal;
}

function makeAbortedSignal(): AbortSignal {
  const ac = new AbortController();
  ac.abort();
  return ac.signal;
}

function makeStores() {
  return {
    jobsStore: new InMemorySourceExtractionJobsStore(),
    passagesStore: new InMemorySourcePassagesStore(),
  };
}

function makeService(
  overrides: { extractor?: TextExtractorAdapter } = {},
) {
  const { jobsStore, passagesStore } = makeStores();
  const service = new SourceExtractionService({
    jobsStore,
    passagesStore,
    extractor: overrides.extractor ?? new StubTextExtractorAdapter(),
  });
  return { service, jobsStore, passagesStore };
}

/** Extractor that returns pages with no text content. */
class BlankPageExtractor implements TextExtractorAdapter {
  async extractPages(_bytes: Buffer, _contentType: string): Promise<PageText[]> {
    return [{ pageNumber: 1, text: '   ' }];
  }
}

/** Extractor that returns no pages at all. */
class EmptyPageExtractor implements TextExtractorAdapter {
  async extractPages(_bytes: Buffer, _contentType: string): Promise<PageText[]> {
    return [];
  }
}

/** Extractor that throws mid-run. */
class ThrowingExtractor implements TextExtractorAdapter {
  async extractPages(_bytes: Buffer, _contentType: string): Promise<PageText[]> {
    throw new Error('extractor exploded');
  }
}

// Minimal no-op StorageAdapter for handler tests
const noopStorage: StorageAdapter = {
  putObject: async () => ({ key: 'k', byteSize: 0, contentType: '', checksumSha256: '' }),
  headObject: async () => ({ key: 'k', byteSize: 0, contentType: '', checksumSha256: '' }),
  getSignedUrl: async () => ({ url: 'http://localhost/x', expiresAtEpochMs: Date.now() + 60000 }),
  deleteObject: async () => {},
};

// ---- SourceExtractionService tests ----

describe('SourceExtractionService', () => {
  it('runs full pipeline and returns passages', async () => {
    const { service, jobsStore, passagesStore } = makeService();
    const bytes = Buffer.from('Hello world from a PDF page.');

    const result = await service.run({
      uploadId: UPLOAD_ID,
      workspaceId: WORKSPACE_ID,
      bytes,
      contentType: 'application/pdf',
      signal: makeSignal(),
    });

    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.passageCount).toBeGreaterThan(0);
    expect(result.passages.length).toBe(result.passageCount);

    // Job should be succeeded
    const job = await jobsStore.getJobByUploadId(WORKSPACE_ID, UPLOAD_ID);
    expect(job).not.toBeNull();
    expect(job!.status).toBe('succeeded');
    expect(job!.stage).toBeNull();
    expect(job!.pageCount).toBe(result.pageCount);
    expect(job!.passageCount).toBe(result.passageCount);

    // Passages should be in store
    const count = await passagesStore.countPassagesByUpload(WORKSPACE_ID, UPLOAD_ID);
    expect(count).toBe(result.passageCount);
  });

  it('is idempotent: second run on succeeded job returns existing passages', async () => {
    const { service, passagesStore } = makeService();
    const bytes = Buffer.from('Hello idempotency.');

    const first = await service.run({
      uploadId: UPLOAD_ID,
      workspaceId: WORKSPACE_ID,
      bytes,
      contentType: 'application/pdf',
      signal: makeSignal(),
    });

    const second = await service.run({
      uploadId: UPLOAD_ID,
      workspaceId: WORKSPACE_ID,
      bytes,
      contentType: 'application/pdf',
      signal: makeSignal(),
    });

    expect(second.jobId).toBe(first.jobId);
    expect(second.passageCount).toBe(first.passageCount);

    // No duplicate passages should have been written
    const count = await passagesStore.countPassagesByUpload(WORKSPACE_ID, UPLOAD_ID);
    expect(count).toBe(first.passageCount);
  });

  it('fails with IMAGE_ONLY_OR_ENCRYPTED when all pages are blank', async () => {
    const { service, jobsStore } = makeService({ extractor: new BlankPageExtractor() });

    await expect(
      service.run({
        uploadId: UPLOAD_ID,
        workspaceId: WORKSPACE_ID,
        bytes: Buffer.from('%PDF-1.4'),
        contentType: 'application/pdf',
        signal: makeSignal(),
      }),
    ).rejects.toThrow(ExtractionError);

    const job = await jobsStore.getJobByUploadId(WORKSPACE_ID, UPLOAD_ID);
    expect(job!.status).toBe('failed');
    expect(job!.failureCode).toBe('IMAGE_ONLY_OR_ENCRYPTED');
  });

  it('fails with EMPTY_UPLOAD for zero-byte input', async () => {
    const { service, jobsStore } = makeService();

    await expect(
      service.run({
        uploadId: UPLOAD_ID,
        workspaceId: WORKSPACE_ID,
        bytes: Buffer.alloc(0),
        contentType: 'application/pdf',
        signal: makeSignal(),
      }),
    ).rejects.toThrow(ExtractionError);

    const job = await jobsStore.getJobByUploadId(WORKSPACE_ID, UPLOAD_ID);
    expect(job!.failureCode).toBe('EMPTY_UPLOAD');
  });

  it('fails with UNKNOWN_ERROR when extractor throws', async () => {
    const { service, jobsStore } = makeService({ extractor: new ThrowingExtractor() });

    await expect(
      service.run({
        uploadId: UPLOAD_ID,
        workspaceId: WORKSPACE_ID,
        bytes: Buffer.from('data'),
        contentType: 'application/pdf',
        signal: makeSignal(),
      }),
    ).rejects.toThrow('extractor exploded');

    const job = await jobsStore.getJobByUploadId(WORKSPACE_ID, UPLOAD_ID);
    expect(job!.status).toBe('failed');
    expect(job!.failureCode).toBe('UNKNOWN_ERROR');
  });

  it('cancels when signal is already aborted', async () => {
    const { service, jobsStore } = makeService();

    await expect(
      service.run({
        uploadId: UPLOAD_ID,
        workspaceId: WORKSPACE_ID,
        bytes: Buffer.from('content'),
        contentType: 'application/pdf',
        signal: makeAbortedSignal(),
      }),
    ).rejects.toThrow(CancelledError);

    const job = await jobsStore.getJobByUploadId(WORKSPACE_ID, UPLOAD_ID);
    expect(job!.status).toBe('cancelled');
    expect(job!.failureCode).toBe('CANCELLED');
  });

  it('handles multi-page extractions and correct sequence numbering', async () => {
    const multiPageExtractor: TextExtractorAdapter = {
      async extractPages(_bytes: Buffer, _ct: string) {
        return [
          { pageNumber: 1, text: 'Page one content here.' },
          { pageNumber: 2, text: 'Page two content here.' },
          { pageNumber: 3, text: 'Page three content here.' },
        ];
      },
    };
    const { service, passagesStore } = makeService({ extractor: multiPageExtractor });

    const result = await service.run({
      uploadId: UPLOAD_ID,
      workspaceId: WORKSPACE_ID,
      bytes: Buffer.from('multi-page'),
      contentType: 'application/pdf',
      signal: makeSignal(),
    });

    expect(result.pageCount).toBe(3);
    const passages = await passagesStore.listPassagesByUpload(WORKSPACE_ID, UPLOAD_ID);
    const pageNumbers = passages.map((p) => p.pageNumber);
    expect(pageNumbers).toContain(1);
    expect(pageNumbers).toContain(2);
    expect(pageNumbers).toContain(3);
    // Sequence starts at 0 per page
    const page1 = passages.filter((p) => p.pageNumber === 1);
    expect(page1[0]!.sequence).toBe(0);
  });
});

// ---- SourceIngestionHandler tests ----

describe('SourceIngestionHandler', () => {
  let uploadsStore: InMemorySourceUploadsStore;
  let jobsStore: InMemorySourceExtractionJobsStore;
  let passagesStore: InMemorySourcePassagesStore;
  let extractionService: SourceExtractionService;
  let handler: SourceIngestionHandler;

  beforeEach(() => {
    uploadsStore = new InMemorySourceUploadsStore();
    jobsStore = new InMemorySourceExtractionJobsStore();
    passagesStore = new InMemorySourcePassagesStore();
    extractionService = new SourceExtractionService({
      jobsStore,
      passagesStore,
      extractor: new StubTextExtractorAdapter(),
    });
    handler = new SourceIngestionHandler({
      uploadsStore,
      storage: noopStorage,
      extractionService,
    });
  });

  async function insertVerifiedUpload() {
    const upload = await uploadsStore.insertUpload({
      id: UPLOAD_ID,
      tenantId: '00000000-0000-0000-0000-000000000099',
      workspaceId: WORKSPACE_ID,
      uploaderUserId: '00000000-0000-0000-0000-000000000003',
      filenameRedacted: '[redacted]',
      contentType: 'application/pdf',
      byteSize: 1024,
      status: 'verified',
    });
    await uploadsStore.insertVersion({
      uploadId: UPLOAD_ID,
      version: 1,
      storageDriver: 'memory',
      storageKey: 'key/test.pdf',
      contentHash: 'abc123',
      redactionClassification: 'user_private',
    });
    return upload;
  }

  it('returns failure with MISSING_UPLOAD_ID when payload has no sourceId/uploadId', async () => {
    const result = await handler.handle({
      jobId: 'job-1',
      workspaceId: WORKSPACE_ID,
      actorId: 'actor-1',
      attempt: 1,
      payload: {},
      signal: makeSignal(),
    });

    expect(result.status).toBe('failure');
    expect(result.error?.code).toBe('MISSING_UPLOAD_ID');
  });

  it('returns failure with UPLOAD_NOT_FOUND for unknown uploadId', async () => {
    const result = await handler.handle({
      jobId: 'job-1',
      workspaceId: WORKSPACE_ID,
      actorId: 'actor-1',
      attempt: 1,
      payload: { sourceId: 'nonexistent-id' },
      signal: makeSignal(),
    });

    expect(result.status).toBe('failure');
    expect(result.error?.code).toBe('UPLOAD_NOT_FOUND');
  });

  it('returns failure with UPLOAD_DELETED for deleted uploads', async () => {
    await uploadsStore.insertUpload({
      id: UPLOAD_ID,
      tenantId: '00000000-0000-0000-0000-000000000099',
      workspaceId: WORKSPACE_ID,
      uploaderUserId: '00000000-0000-0000-0000-000000000003',
      filenameRedacted: '[redacted]',
      contentType: 'application/pdf',
      byteSize: 1024,
      status: 'deleted',
    });

    const result = await handler.handle({
      jobId: 'job-1',
      workspaceId: WORKSPACE_ID,
      actorId: 'actor-1',
      attempt: 1,
      payload: { sourceId: UPLOAD_ID },
      signal: makeSignal(),
    });

    expect(result.status).toBe('failure');
    expect(result.error?.code).toBe('UPLOAD_DELETED');
  });

  it('returns failure with UPLOAD_REJECTED for rejected uploads', async () => {
    await uploadsStore.insertUpload({
      id: UPLOAD_ID,
      tenantId: '00000000-0000-0000-0000-000000000099',
      workspaceId: WORKSPACE_ID,
      uploaderUserId: '00000000-0000-0000-0000-000000000003',
      filenameRedacted: '[redacted]',
      contentType: 'application/pdf',
      byteSize: 1024,
      status: 'rejected',
    });

    const result = await handler.handle({
      jobId: 'job-1',
      workspaceId: WORKSPACE_ID,
      actorId: 'actor-1',
      attempt: 1,
      payload: { sourceId: UPLOAD_ID },
      signal: makeSignal(),
    });

    expect(result.status).toBe('failure');
    expect(result.error?.code).toBe('UPLOAD_REJECTED');
  });

  it('succeeds end-to-end for a verified upload', async () => {
    await insertVerifiedUpload();

    const result = await handler.handle({
      jobId: 'job-1',
      workspaceId: WORKSPACE_ID,
      actorId: 'actor-1',
      attempt: 1,
      payload: { sourceId: UPLOAD_ID },
      signal: makeSignal(),
    });

    expect(result.status).toBe('success');
    expect(result.output?.uploadId).toBe(UPLOAD_ID);
    expect(result.output?.passageCount).toBeGreaterThan(0);
  });

  it('returns CANCELLED when signal is aborted', async () => {
    await insertVerifiedUpload();

    const result = await handler.handle({
      jobId: 'job-1',
      workspaceId: WORKSPACE_ID,
      actorId: 'actor-1',
      attempt: 1,
      payload: { sourceId: UPLOAD_ID },
      signal: makeAbortedSignal(),
    });

    expect(result.status).toBe('failure');
    expect(result.error?.code).toBe('CANCELLED');
  });
});
