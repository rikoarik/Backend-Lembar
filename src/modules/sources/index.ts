/**
 * B2-02 — Public re-exports for the sources module.
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
