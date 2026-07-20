/**
 * B3-01 — In-memory implementation of SourceRetrievalStore.
 *
 * Delegates to InMemorySourcePassagesStore and InMemorySourceUploadsStore
 * so tests can use a single coherent in-memory state.
 *
 * Tenant isolation: every query filters by workspaceId. Cross-workspace
 * reads return empty, never leak content.
 */
import type { RetrievedPassage, SourceRetrievalStore } from '../domain/SourceRetrieval.js';
import type { InMemorySourcePassagesStore } from './InMemorySourceExtractionStores.js';
import type { InMemorySourceUploadsStore } from '../../uploads/persistence/InMemorySourceUploadsStore.js';

export interface InMemorySourceRetrievalStoreOptions {
  passagesStore: InMemorySourcePassagesStore;
  uploadsStore: InMemorySourceUploadsStore;
}

export class InMemorySourceRetrievalStore implements SourceRetrievalStore {
  private readonly passagesStore: InMemorySourcePassagesStore;
  private readonly uploadsStore: InMemorySourceUploadsStore;

  constructor(options: InMemorySourceRetrievalStoreOptions) {
    this.passagesStore = options.passagesStore;
    this.uploadsStore = options.uploadsStore;
  }

  async listPassagesForUpload(
    workspaceId: string,
    uploadId: string,
    options: { limit?: number } = {},
  ): Promise<RetrievedPassage[]> {
    const passages = await this.passagesStore.listPassagesByUpload(workspaceId, uploadId, {
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
    return passages.map((p) => ({
      passageId: p.id,
      uploadId: p.uploadId,
      pageNumber: p.pageNumber,
      sequence: p.sequence,
      text: p.textNormalized,
      charCount: p.charCount,
      contentHash: p.contentHash,
    }));
  }

  async listPassagesForUploads(
    workspaceId: string,
    uploadIds: string[],
    options: { limitPerUpload?: number } = {},
  ): Promise<Map<string, RetrievedPassage[]>> {
    const result = new Map<string, RetrievedPassage[]>();
    for (const uploadId of uploadIds) {
      const passages = await this.listPassagesForUpload(workspaceId, uploadId, {
        ...(options.limitPerUpload !== undefined ? { limit: options.limitPerUpload } : {}),
      });
      result.set(uploadId, passages);
    }
    return result;
  }

  async getPassageById(workspaceId: string, passageId: string): Promise<RetrievedPassage | null> {
    // Linear scan is fine for in-memory tests
    const allPassages = (
      this.passagesStore as unknown as {
        passages: Array<{
          id: string;
          workspaceId: string;
          uploadId: string;
          pageNumber: number;
          sequence: number;
          textNormalized: string;
          charCount: number;
          contentHash: string;
        }>;
      }
    ).passages;

    const found = allPassages.find((p) => p.id === passageId && p.workspaceId === workspaceId);

    if (!found) return null;

    return {
      passageId: found.id,
      uploadId: found.uploadId,
      pageNumber: found.pageNumber,
      sequence: found.sequence,
      text: found.textNormalized,
      charCount: found.charCount,
      contentHash: found.contentHash,
    };
  }

  async getReadyUploadIds(workspaceId: string, uploadIds: string[]): Promise<string[]> {
    const ready: string[] = [];
    for (const uploadId of uploadIds) {
      const upload = await this.uploadsStore.getUploadByIdForWorkspace(workspaceId, uploadId);
      if (upload && upload.status === 'verified') {
        ready.push(uploadId);
      }
    }
    return ready;
  }
}
