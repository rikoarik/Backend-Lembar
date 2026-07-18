import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { safeLogShape } from '../common/redact.js';
import {
  createStorageAdapter,
  resolveStorageDriver,
} from '../infrastructure/storage/createStorageAdapter.js';
import { InMemoryAdapter } from '../infrastructure/storage/InMemoryAdapter.js';
import { LocalFilesystemAdapter } from '../infrastructure/storage/LocalFilesystemAdapter.js';

async function main(): Promise<void> {
  const driver = resolveStorageDriver(process.env);
  const key = 'spike/private-artifacts/example.pdf';
  const rootDir =
    driver === 'local' ? await mkdtemp(path.join(os.tmpdir(), 'lembar-storage-')) : null;

  try {
    const adapter = createStorageAdapter({
      driver,
      ...(rootDir ? { rootDir } : {}),
      signingSecret: 'b0-07',
    });
    const put = await adapter.putObject({
      key,
      body: 'storage spike payload',
      contentType: 'application/pdf',
    });
    assert.equal(put.key, key);

    const signed = await adapter.getSignedUrl(key, { expiresInSeconds: 2 });
    assert.equal(signed.expiresAtEpochMs > Date.now(), true);
    assert.equal(
      (await resolveSigned(adapter, signed.url))?.toString('utf8'),
      'storage spike payload',
    );

    const logLine = JSON.stringify({
      event: 'storage.smoke.ok',
      driver,
      key: safeLogShape(key),
      signedUrl: safeLogShape(signed.url),
      expiresAtEpochMs: signed.expiresAtEpochMs,
      checksumSha256: put.checksumSha256,
    });
    assert.equal(logLine.includes(key), false);
    assert.equal(logLine.includes(signed.url), false);
    process.stdout.write(`${logLine}\n`);
  } finally {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  }
}

async function resolveSigned(
  adapter: ReturnType<typeof createStorageAdapter>,
  url: string,
): Promise<Buffer | null> {
  if (adapter instanceof InMemoryAdapter) return adapter.resolveSignedUrl(url)?.body ?? null;
  if (adapter instanceof LocalFilesystemAdapter)
    return (await adapter.resolveSignedUrl(url))?.body ?? null;
  return null;
}

await main();
