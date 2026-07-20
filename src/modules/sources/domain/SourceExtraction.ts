/**
 * B2-02 — Domain types for source extraction: passages and extraction jobs.
 *
 * Extraction pipeline stages: verifying_upload → scanning → extracting → chunking → indexing
 *
 * - SourcePassage: one normalized text chunk extracted from a single page of an upload.
 * - SourceExtractionJob: tracks progress/status of a single extraction run per upload.
 *
 * Tenant isolation: every store method that reads requires workspaceId.
 */

export type ExtractionJobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type ExtractionStage =
  | 'verifying_upload'
  | 'scanning'
  | 'extracting'
  | 'chunking'
  | 'indexing';

export interface SourceExtractionJob {
  id: string;
  uploadId: string;
  workspaceId: string;
  status: ExtractionJobStatus;
  stage: ExtractionStage | null;
  attempt: number;
  failureCode: string | null;
  parserVersion: string;
  pageCount: number | null;
  passageCount: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourcePassage {
  id: string;
  uploadId: string;
  workspaceId: string;
  extractionJobId: string;
  pageNumber: number;
  sequence: number;
  textNormalized: string;
  charCount: number;
  contentHash: string;
  parserVersion: string;
  createdAt: string;
}

// ---- store input types ----

export interface CreateExtractionJobInput {
  uploadId: string;
  workspaceId: string;
  parserVersion?: string;
}

export interface UpdateExtractionJobInput {
  id: string;
  status?: ExtractionJobStatus;
  stage?: ExtractionStage | null;
  attempt?: number;
  failureCode?: string | null;
  pageCount?: number | null;
  passageCount?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface InsertPassageInput {
  uploadId: string;
  workspaceId: string;
  extractionJobId: string;
  pageNumber: number;
  sequence: number;
  textNormalized: string;
  contentHash: string;
  parserVersion: string;
}

// ---- store contracts ----

export interface SourceExtractionJobsStore {
  createJob(input: CreateExtractionJobInput): Promise<SourceExtractionJob>;
  getJobByUploadId(workspaceId: string, uploadId: string): Promise<SourceExtractionJob | null>;
  getJobById(id: string): Promise<SourceExtractionJob | null>;
  updateJob(input: UpdateExtractionJobInput): Promise<SourceExtractionJob>;
}

export interface SourcePassagesStore {
  insertPassage(input: InsertPassageInput): Promise<SourcePassage>;
  insertPassages(inputs: InsertPassageInput[]): Promise<SourcePassage[]>;
  listPassagesByUpload(
    workspaceId: string,
    uploadId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<SourcePassage[]>;
  countPassagesByUpload(workspaceId: string, uploadId: string): Promise<number>;
  deletePassagesByJob(extractionJobId: string): Promise<void>;
}
