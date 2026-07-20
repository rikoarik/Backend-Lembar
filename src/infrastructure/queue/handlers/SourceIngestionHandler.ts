/**
 * Handler for source_ingestion jobs.
 *
 * Processes uploaded source materials (PDFs, documents) — extracts text,
 * generates embeddings, stores in vector index.
 */
import type { JobHandler, JobContext, JobResult } from '../domain/JobHandler.js';

export class SourceIngestionHandler implements JobHandler {
  readonly kind = 'source_ingestion' as const;

  async handle(context: JobContext): Promise<JobResult> {
    const { payload, signal } = context;

    try {
      // TODO: Implement actual source ingestion logic
      // 1. Fetch source file from storage
      // 2. Extract text content
      // 3. Generate embeddings
      // 4. Store in vector database
      // 5. Update source status to 'ready'

      console.log(
        `[SourceIngestionHandler] Processing job ${context.jobId} for workspace ${context.workspaceId}`,
      );

      // Simulate work
      await this.simulateProcessing(signal);

      return {
        status: 'success',
        output: {
          sourceId: payload.sourceId,
          pagesProcessed: 10,
          textExtracted: true,
          embeddingsGenerated: true,
        },
      };
    } catch (err) {
      if (signal.aborted) {
        return {
          status: 'failure',
          error: {
            code: 'CANCELLED',
            message: 'Job was cancelled',
          },
        };
      }

      return {
        status: 'failure',
        error: {
          code: 'PROCESSING_ERROR',
          message: err instanceof Error ? err.message : String(err),
          details: err,
        },
      };
    }
  }

  private async simulateProcessing(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), 2000);

      signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(new Error('Aborted'));
      });
    });
  }
}
