import type { RenderAdapter, RenderArtifact, RenderPdfOptions } from './RenderAdapter.js';

/**
 * TODO(D-020): implement after Playwright/Chromium renderer acceptance.
 * This placeholder keeps the interface path isolated without adding the
 * dependency during the B0-07 spike.
 */
export class PlaywrightHtmlToPdfAdapter implements RenderAdapter {
  async renderPdf(_html: string, _options: RenderPdfOptions): Promise<RenderArtifact> {
    throw new Error('PlaywrightHtmlToPdfAdapter disabled in B0-07 spike; D-020 still open');
  }
}
