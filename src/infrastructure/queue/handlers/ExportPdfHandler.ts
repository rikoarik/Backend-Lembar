/**
 * Handler for export_pdf jobs.
 *
 * Renders finalized assessment to PDF format using the configured RenderAdapter.
 * In development/CI the StubHtmlToPdfAdapter is used; in production the adapter
 * is selected via the PDF_RENDERER env var (see createRenderAdapter).
 */
import type { JobHandler, JobContext, JobResult } from '../domain/JobHandler.js';
import type { RenderAdapter } from '../../pdf/RenderAdapter.js';
import { createRenderAdapter } from '../../pdf/createRenderAdapter.js';

export class ExportPdfHandler implements JobHandler {
  readonly kind = 'export_pdf' as const;

  private readonly renderer: RenderAdapter;

  constructor(renderer: RenderAdapter = createRenderAdapter()) {
    this.renderer = renderer;
  }

  async handle(context: JobContext): Promise<JobResult> {
    const { payload, signal } = context;

    if (signal.aborted) {
      return { status: 'failure', error: { code: 'CANCELLED', message: 'Job was cancelled' } };
    }

    console.log(
      `[ExportPdfHandler] Processing job ${context.jobId} for workspace ${context.workspaceId}`,
    );

    try {
      // ponytail: HTML is minimal placeholder; real template lands when assessment data layer is wired
      const html = `<html><body><h1>Assessment ${String(payload.assessmentId)}</h1></body></html>`;
      const artifact = await this.renderer.renderPdf(html, { pageFormat: 'A4' });

      return {
        status: 'success',
        output: {
          assessmentId: payload.assessmentId,
          exportId: payload.exportId,
          format: 'pdf',
          mediaType: artifact.mediaType,
          sizeBytes: artifact.byteSize,
          checksumSha256: artifact.checksumSha256,
          rendererVersion: artifact.rendererVersion,
        },
      };
    } catch (err) {
      if (signal.aborted) {
        return { status: 'failure', error: { code: 'CANCELLED', message: 'Job was cancelled' } };
      }
      return {
        status: 'failure',
        error: {
          code: 'EXPORT_ERROR',
          message: err instanceof Error ? err.message : String(err),
          details: err,
        },
      };
    }
  }
}
