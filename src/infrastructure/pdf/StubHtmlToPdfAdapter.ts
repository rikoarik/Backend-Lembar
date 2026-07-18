import { createHash } from 'node:crypto';

import type { RenderAdapter, RenderArtifact, RenderPdfOptions } from './RenderAdapter.js';

export const STUB_RENDERER_VERSION = 'stub-html-to-pdf-v1';

/**
 * Deterministic spike renderer. Produces stable bytes from html+options so we
 * can pin a golden fixture before choosing the real renderer.
 */
export class StubHtmlToPdfAdapter implements RenderAdapter {
  async renderPdf(html: string, options: RenderPdfOptions): Promise<RenderArtifact> {
    const normalized = JSON.stringify({ html, options, rendererVersion: STUB_RENDERER_VERSION });
    const digest = createHash('sha256').update(normalized).digest('hex');
    const bytes = Buffer.from(`PDF-STUB\n${digest}\n`, 'utf8');
    return {
      mediaType: 'application/pdf',
      bytes,
      byteSize: bytes.byteLength,
      checksumSha256: createHash('sha256').update(bytes).digest('hex'),
      rendererVersion: STUB_RENDERER_VERSION,
    };
  }
}
