import type { RenderAdapter } from './RenderAdapter.js';
import { PlaywrightHtmlToPdfAdapter } from './PlaywrightHtmlToPdfAdapter.js';
import { StubHtmlToPdfAdapter } from './StubHtmlToPdfAdapter.js';

export type PdfRendererDriver = 'stub' | 'playwright';

export function resolvePdfRendererDriver(env: NodeJS.ProcessEnv = process.env): PdfRendererDriver {
  const raw = (env['PDF_RENDERER_DRIVER'] ?? 'stub').toLowerCase();
  if (raw === 'stub' || raw === 'playwright') return raw;
  throw new Error(`Unsupported PDF_RENDERER_DRIVER: ${raw}`);
}

export function createRenderAdapter(env: NodeJS.ProcessEnv = process.env): RenderAdapter {
  switch (resolvePdfRendererDriver(env)) {
    case 'stub':
      return new StubHtmlToPdfAdapter();
    case 'playwright':
      return new PlaywrightHtmlToPdfAdapter();
  }
}
