/**
 * B2-02 — In-memory implementation of SourceExtractionJobsStore and SourcePassagesStore.
 *
 * Used by unit tests and smoke; mirrors Postgres shape exactly so switching
 * adapters doesn't break call sites.
 */
import { createHash, randomUUID } from 'node:crypto';

import type {
  CreateExtractionJobInput,
  ExtractionJobStatus,
  ExtractionStage,
  InsertPassageInput,
  SourceExtractionJob,
  SourceExtractionJobsStore,
  SourcePassage,
  SourcePassagesStore,
  UpdateExtractionJobInput,
} from '../domain/SourceExtraction.js';

// ---- Jobs store ----

export class InMemorySourceExtractionJobsStore implements SourceExtractionJobsStore {
  private readonly jobs = new Map<string, SourceExtractionJob>();

  async createJob(input: CreateExtractionJobInput): Promise<SourceExtractionJob> {
    const now = new Date().toISOString();
    const job: SourceExtractionJob = {
      id: randomUUID(),
      uploadId: input.uploadId,
      workspaceId: input.workspaceId,
      status: 'pending',
      stage: null,
      attempt: 0,
      failureCode: null,
      parserVersion: input.parserVersion ?? '1',
      pageCount: null,
      passageCount: null,
      startedAt: null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    return { ...job };
  }

  async getJobByUploadId(
    workspaceId: string,
    uploadId: string,
  ): Promise<SourceExtractionJob | null> {
    for (const job of this.jobs.values()) {
      if (job.workspaceId === workspaceId && job.uploadId === uploadId) {
        return { ...job };
      }
    }
    return null;
  }

  async getJobById(id: string): Promise<SourceExtractionJob | null> {
    const job = this.jobs.get(id);
    return job ? { ...job } : null;
  }

  async updateJob(input: UpdateExtractionJobInput): Promise<SourceExtractionJob> {
    const existing = this.jobs.get(input.id);
    if (!existing) {
      throw new Error(`ExtractionJob not found: ${input.id}`);
    }
    const updated: SourceExtractionJob = {
      ...existing,
      ...(input.status !== undefined ? { status: input.status as ExtractionJobStatus } : {}),
      ...(input.stage !== undefined ? { stage: input.stage as ExtractionStage | null } : {}),
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      ...(input.failureCode !== undefined ? { failureCode: input.failureCode } : {}),
      ...(input.pageCount !== undefined ? { pageCount: input.pageCount } : {}),
      ...(input.passageCount !== undefined ? { passageCount: input.passageCount } : {}),
      ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(input.id, updated);
    return { ...updated };
  }
}

// ---- Passages store ----

export class InMemorySourcePassagesStore implements SourcePassagesStore {
  private readonly passages: SourcePassage[] = [];

  async insertPassage(input: InsertPassageInput): Promise<SourcePassage> {
    const passage: SourcePassage = {
      id: randomUUID(),
      uploadId: input.uploadId,
      workspaceId: input.workspaceId,
      extractionJobId: input.extractionJobId,
      pageNumber: input.pageNumber,
      sequence: input.sequence,
      textNormalized: input.textNormalized,
      charCount: input.textNormalized.length,
      contentHash: input.contentHash,
      parserVersion: input.parserVersion,
      createdAt: new Date().toISOString(),
    };
    this.passages.push(passage);
    return { ...passage };
  }

  async insertPassages(inputs: InsertPassageInput[]): Promise<SourcePassage[]> {
    const results: SourcePassage[] = [];
    for (const input of inputs) {
      results.push(await this.insertPassage(input));
    }
    return results;
  }

  async listPassagesByUpload(
    workspaceId: string,
    uploadId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<SourcePassage[]> {
    const { limit = 100, offset = 0 } = options;
    return this.passages
      .filter((p) => p.workspaceId === workspaceId && p.uploadId === uploadId)
      .sort((a, b) => a.pageNumber - b.pageNumber || a.sequence - b.sequence)
      .slice(offset, offset + limit)
      .map((p) => ({ ...p }));
  }

  async countPassagesByUpload(workspaceId: string, uploadId: string): Promise<number> {
    return this.passages.filter(
      (p) => p.workspaceId === workspaceId && p.uploadId === uploadId,
    ).length;
  }

  async deletePassagesByJob(extractionJobId: string): Promise<void> {
    for (let i = this.passages.length - 1; i >= 0; i--) {
      if (this.passages[i]!.extractionJobId === extractionJobId) {
        this.passages.splice(i, 1);
      }
    }
  }
}

/**
 * Compute a stable sha256 hex hash of a text string.
 * Exported so callers don't have to import node:crypto directly.
 */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
