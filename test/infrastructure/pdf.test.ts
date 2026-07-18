import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  createRenderAdapter,
  resolvePdfRendererDriver,
} from '../../src/infrastructure/pdf/createRenderAdapter.js';
import { PlaywrightHtmlToPdfAdapter } from '../../src/infrastructure/pdf/PlaywrightHtmlToPdfAdapter.js';
import { StubHtmlToPdfAdapter } from '../../src/infrastructure/pdf/StubHtmlToPdfAdapter.js';

const GOLDEN_SHA256 = '4e39e9a4160996e94a32f87ef7411d3a354542b938e01edc0b628681c2836463';

describe('StubHtmlToPdfAdapter', () => {
  it('renders deterministic bytes for the A4 fixture', async () => {
    const html = await readFile('src/infrastructure/pdf/fixture-a4.html', 'utf8');
    const adapter = new StubHtmlToPdfAdapter();
    const artifact = await adapter.renderPdf(html, {
      pageFormat: 'A4',
      marginMm: { top: 20, right: 16, bottom: 20, left: 16 },
      printBackground: true,
      locale: 'id-ID',
    });
    const sha = createHash('sha256').update(artifact.bytes).digest('hex');
    expect(sha).toBe(GOLDEN_SHA256);
    expect(artifact.mediaType).toBe('application/pdf');
  });
});

describe('PDF renderer selector', () => {
  it('selects the disabled Playwright adapter via PDF_RENDERER', async () => {
    expect(resolvePdfRendererDriver({ PDF_RENDERER: 'playwright' })).toBe('playwright');
    const adapter = createRenderAdapter({ PDF_RENDERER: 'playwright' });
    expect(adapter).toBeInstanceOf(PlaywrightHtmlToPdfAdapter);
    await expect(adapter.renderPdf('<html></html>', { pageFormat: 'A4' })).rejects.toThrow(
      'PlaywrightHtmlToPdfAdapter disabled in B0-07 spike; D-020 still open',
    );
  });
});
