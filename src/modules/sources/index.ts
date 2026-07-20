/**
 * B2-02 + B3-01 — Public re-exports for the sources module.
 */
export type {
  ExtractionJobStatus,
  ExtractionStage,
  SourceExtractionJob,
  SourcePassage,
  CreateExtractionJobInput,
  UpdateExtractionJobInput,
  InsertPassageInput,
  SourceExtractionJobsStore,
  SourcePassagesStore,
} from './domain/SourceExtraction.js';

export {
  SourceExtractionService,
  StubTextExtractorAdapter,
  ExtractionError,
  CancelledError,
  createSourceExtractionService,
} from './application/SourceExtractionService.js';

export type {
  PageText,
  TextExtractorAdapter,
  SourceExtractionServiceOptions,
  RunExtractionInput,
  RunExtractionResult,
} from './application/SourceExtractionService.js';

export {
  InMemorySourceExtractionJobsStore,
  InMemorySourcePassagesStore,
  hashText,
} from './persistence/InMemorySourceExtractionStores.js';

// B3-01 — Tenant-scoped retrieval and citation resolution
export type {
  RetrievePassagesInput,
  RetrievedPassage,
  RetrievePassagesResult,
  ResolveCitationsInput,
  ResolvedCitation,
  ResolveCitationsResult,
  InsufficientSourceReason,
  SourceRetrievalStore,
} from './domain/SourceRetrieval.js';

export { InsufficientSourceError } from './domain/SourceRetrieval.js';

export {
  SourceRetrievalService,
  sanitizeSourceText,
  createSourceRetrievalService,
} from './application/SourceRetrievalService.js';

export type { SourceRetrievalServiceOptions } from './application/SourceRetrievalService.js';

export { InMemorySourceRetrievalStore } from './persistence/InMemorySourceRetrievalStore.js';
