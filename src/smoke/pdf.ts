import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { safeLogShape } from '../common/redact.js';
import { createRenderAdapter } from '../infrastructure/pdf/createRenderAdapter.js';

const FIXTURE_PATH = 'src/infrastructure/pdf/fixture-a4.html';
const GOLDEN_SHA256 = '4e39e9a4160996e94a32f87ef7411d3a354542b938e01edc0b628681c2836463';

async function main(): Promise<void> {
  const html = await readFile(FIXTURE_PATH, 'utf8');
  const adapter = createRenderAdapter(process.env);
  const artifact = await adapter.renderPdf(html, {
    pageFormat: 'A4',
    marginMm: { top: 20, right: 16, bottom: 20, left: 16 },
    printBackground: true,
    locale: 'id-ID',
  });
  assert.equal(artifact.mediaType, 'application/pdf');
  const sha = createHash('sha256').update(artifact.bytes).digest('hex');
  assert.equal(sha, GOLDEN_SHA256);

  const logLine = JSON.stringify({
    event: 'pdf.smoke.ok',
    rendererVersion: artifact.rendererVersion,
    artifact: safeLogShape(artifact.checksumSha256),
    sha256: sha,
    bytes: artifact.byteSize,
  });
  process.stdout.write(`${logLine}\n`);
}

await main();
