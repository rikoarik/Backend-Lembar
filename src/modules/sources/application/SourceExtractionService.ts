/**
 * B2-02 — Source extraction service.
 *
 * Drives the 5-stage pipeline for a single upload:
 *   verifying_upload → scanning → extracting → chunking → indexing
 *
 * Design constraints:
 * - Each stage checks AbortSignal before doing work (cancellation support).
 * - Idempotent on re-run: if a job already exists for the upload, it is reused
 *   (status reset to running on retry unless already succeeded).
 * - No real PDF parser is used here; a text-extraction adapter interface is
 *   defined so a real parser (pdfjs, pdf2pic, etc.) can be plugged in later
 *   without changing this service (per D-004 / use-local-adapters-when-credentials-absent).
 * - Passages are chunked to CHUNK_MAX_CHARS; overlapping is intentionally not
 *   implemented in B2-02 (deferred to embedding/vector task).
 * - Tenant isolation: every store call includes workspaceId.
 */
import { createHash } from 'node:crypto';

import type {
  ExtractionStage,
  InsertPassageInput,
  SourceExtractionJob,
  SourceExtractionJobsStore,
  SourcePassage,
  SourcePassagesStore,
} from '../domain/SourceExtraction.js';

// ---- Text extraction adapter ----

export interface PageText {
  pageNumber: number;
  text: string;
}

/**
 * Minimal contract for a PDF/document text extractor.
 * The stub adapter returns synthetic pages so the pipeline runs without
 * an actual parser binary. A real adapter (pdfjs-dist, pdf2pic + OCR, etc.)
 * implements this same interface.
 */
export interface TextExtractorAdapter {
  /** Extract per-page text from raw bytes. Returns pages in order. */
  extractPages(bytes: Buffer, contentType: string): Promise<PageText[]>;
}

/** Stub extractor used when no real parser is configured. */
export class StubTextExtractorAdapter implements TextExtractorAdapter {
  async extractPages(bytes: Buffer, _contentType: string): Promise<PageText[]> {
    // Produce one synthetic "page" that echoes the byte length.
    // Real adapter replaces this without changing the service.
    const pageCount = Math.max(1, Math.ceil(bytes.length / 4096));
    return Array.from({ length: pageCount }, (_, i) => ({
      pageNumber: i + 1,
      text: `[stub-extracted page ${i + 1} of ${pageCount}; ${bytes.length} bytes]`,
    }));
  }
}

// ---- Chunking constants ----

/** Maximum characters per passage chunk. */
const CHUNK_MAX_CHARS = 1500;

/** Parser version tag embedded in every passage row. */
const PARSER_VERSION = '1';

// ---- Service ----

export interface SourceExtractionServiceOptions {
  jobsStore: SourceExtractionJobsStore;
  passagesStore: SourcePassagesStore;
  extractor?: TextExtractorAdapter;
  /** Test seam. */
  now?: () => Date;
}

export interface RunExtractionInput {
  uploadId: string;
  workspaceId: string;
  /** Raw bytes of the uploaded file fetched from storage. */
  bytes: Buffer;
  contentType: string;
  signal: AbortSignal;
}

export interface RunExtractionResult {
  jobId: string;
  pageCount: number;
  passageCount: number;
  passages: SourcePassage[];
}

export class SourceExtractionService {
  private readonly jobsStore: SourceExtractionJobsStore;
  private readonly passagesStore: SourcePassagesStore;
  private readonly extractor: TextExtractorAdapter;
  private readonly now: () => Date;

  constructor(options: SourceExtractionServiceOptions) {
    this.jobsStore = options.jobsStore;
    this.passagesStore = options.passagesStore;
    this.extractor = options.extractor ?? new StubTextExtractorAdapter();
    this.now = options.now ?? (() => new Date());
  }

  async run(input: RunExtractionInput): Promise<RunExtractionResult> {
    const { uploadId, workspaceId, bytes, contentType, signal } = input;

    // -- Stage 0: verifying_upload --
    // Ensure or create the extraction job row.
    let job = await this.jobsStore.getJobByUploadId(workspaceId, uploadId);

    if (!job) {
      job = await this.jobsStore.createJob({ uploadId, workspaceId, parserVersion: PARSER_VERSION });
    }

    // If a previous run already succeeded, return the existing passages.
    if (job.status === 'succeeded') {
      const passages = await this.passagesStore.listPassagesByUpload(workspaceId, uploadId);
      return {
        jobId: job.id,
        pageCount: job.pageCount ?? 0,
        passageCount: job.passageCount ?? passages.length,
        passages,
      };
    }

    // Mark running.
    job = await this.jobsStore.updateJob({
      id: job.id,
      status: 'running',
      stage: 'verifying_upload',
      attempt: job.attempt + 1,
      startedAt: this.now().toISOString(),
      finishedAt: null,
      failureCode: null,
    });

    try {
      this.throwIfAborted(signal, job);

      // -- Stage 1: scanning --
      job = await this.advanceStage(job, 'scanning');
      this.throwIfAborted(signal, job);

      // Validate bytes are non-empty (encrypted/image-only PDFs still produce
      // bytes; we detect blank extraction in the extracting stage).
      if (!bytes || bytes.length === 0) {
        throw new ExtractionError('EMPTY_UPLOAD', 'Upload bytes are empty; cannot extract.');
      }

      // -- Stage 2: extracting --
      job = await this.advanceStage(job, 'extracting');
      this.throwIfAborted(signal, job);

      const pages = await this.extractor.extractPages(bytes, contentType);

      if (pages.length === 0) {
        throw new ExtractionError('NO_PAGES', 'Extractor returned no pages.');
      }

      // Check for image-only / encrypted PDFs: if ALL pages have no text
      // content after normalization, treat as noise/delete.
      const nonEmptyPages = pages.filter((p) => normalizeText(p.text).length > 0);
      if (nonEmptyPages.length === 0) {
        throw new ExtractionError(
          'IMAGE_ONLY_OR_ENCRYPTED',
          'No extractable text found; PDF may be image-only or encrypted.',
        );
      }

      job = await this.jobsStore.updateJob({ id: job.id, pageCount: pages.length });

      // -- Stage 3: chunking --
      job = await this.advanceStage(job, 'chunking');
      this.throwIfAborted(signal, job);

      const passageInputs: InsertPassageInput[] = [];
      for (const page of nonEmptyPages) {
        const normalized = normalizeText(page.text);
        const chunks = chunkText(normalized, CHUNK_MAX_CHARS);
        for (let seq = 0; seq < chunks.length; seq++) {
          const chunk = chunks[seq]!;
          passageInputs.push({
            uploadId,
            workspaceId,
            extractionJobId: job.id,
            pageNumber: page.pageNumber,
            sequence: seq,
            textNormalized: chunk,
            contentHash: hashText(chunk),
            parserVersion: PARSER_VERSION,
          });
        }
      }

      if (passageInputs.length === 0) {
        throw new ExtractionError('NO_PASSAGES', 'Chunking produced zero passages.');
      }

      // -- Stage 4: indexing --
      job = await this.advanceStage(job, 'indexing');
      this.throwIfAborted(signal, job);

      // Delete any passages from a previous failed attempt before inserting.
      await this.passagesStore.deletePassagesByJob(job.id);
      const passages = await this.passagesStore.insertPassages(passageInputs);

      // -- Done --
      job = await this.jobsStore.updateJob({
        id: job.id,
        status: 'succeeded',
        stage: null,
        passageCount: passages.length,
        finishedAt: this.now().toISOString(),
      });

      return {
        jobId: job.id,
        pageCount: pages.length,
        passageCount: passages.length,
        passages,
      };
    } catch (err) {
      // Cancellation
      if (signal.aborted || err instanceof CancelledError) {
        await this.jobsStore.updateJob({
          id: job.id,
          status: 'cancelled',
          stage: null,
          finishedAt: this.now().toISOString(),
          failureCode: 'CANCELLED',
        });
        throw err;
      }

      // Known extraction errors
      if (err instanceof ExtractionError) {
        await this.jobsStore.updateJob({
          id: job.id,
          status: 'failed',
          stage: null,
          finishedAt: this.now().toISOString(),
          failureCode: err.code,
        });
        throw err;
      }

      // Unknown error
      await this.jobsStore.updateJob({
        id: job.id,
        status: 'failed',
        stage: null,
        finishedAt: this.now().toISOString(),
        failureCode: 'UNKNOWN_ERROR',
      });
      throw err;
    }
  }

  /** Get the current extraction job for an upload, if any. */
  async getJob(workspaceId: string, uploadId: string): Promise<SourceExtractionJob | null> {
    return this.jobsStore.getJobByUploadId(workspaceId, uploadId);
  }

  private async advanceStage(
    job: SourceExtractionJob,
    stage: ExtractionStage,
  ): Promise<SourceExtractionJob> {
    return this.jobsStore.updateJob({ id: job.id, stage });
  }

  private throwIfAborted(signal: AbortSignal, _job: SourceExtractionJob): void {
    if (signal.aborted) {
      throw new CancelledError();
    }
  }
}

// ---- Error types ----

export class ExtractionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ExtractionError';
    this.code = code;
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Extraction cancelled');
    this.name = 'CancelledError';
  }
}

// ---- Text utilities ----

/** Collapse whitespace and trim. */
function normalizeText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Split text into chunks of at most maxChars characters, breaking on spaces. */
function chunkText(text: string, maxChars: number): string[] {
  if (text.length === 0) return [];
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    // Find the last space within the limit.
    let splitAt = maxChars;
    const lastSpace = remaining.lastIndexOf(' ', maxChars);
    if (lastSpace > 0) {
      splitAt = lastSpace;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks.filter((c) => c.length > 0);
}

/** sha256 hex of text. */
function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---- Factory ----

export function createSourceExtractionService(options: {
  jobsStore: SourceExtractionJobsStore;
  passagesStore: SourcePassagesStore;
  extractor?: TextExtractorAdapter;
}): SourceExtractionService {
  return new SourceExtractionService(options);
}
