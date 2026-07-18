import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { safeLogShape } from '../../src/common/redact.js';
import { InMemoryAdapter } from '../../src/infrastructure/storage/InMemoryAdapter.js';
import { LocalFilesystemAdapter } from '../../src/infrastructure/storage/LocalFilesystemAdapter.js';

describe('storage redaction', () => {
  it('does not leak raw key or signed URL in JSON logs', async () => {
    const key = 'private/workspace-123/final.pdf';
    const url = 'mem://signed/token/private-key?sig=abc';
    const line = JSON.stringify({ key: safeLogShape(key), url: safeLogShape(url) });
    expect(line).not.toContain(key);
    expect(line).not.toContain(url);
  });
});

describe('signed URL expiry', () => {
  it('expires in-memory signed URLs strictly by clock', async () => {
    let now = 1_000;
    const adapter = new InMemoryAdapter({ signingSecret: 'test', clock: () => now });
    await adapter.putObject({ key: 'private/a.pdf', body: 'hello' });
    const signed = await adapter.getSignedUrl('private/a.pdf', { expiresInSeconds: 2 });
    expect(adapter.resolveSignedUrl(signed.url)?.body.toString('utf8')).toBe('hello');
    now = 3_001;
    expect(adapter.resolveSignedUrl(signed.url)).toBeNull();
  });

  it('expires local filesystem signed URLs strictly by clock', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lembar-storage-test-'));
    let now = 5_000;
    try {
      const adapter = new LocalFilesystemAdapter(rootDir, {
        signingSecret: 'test',
        clock: () => now,
      });
      await adapter.putObject({ key: 'private/b.pdf', body: 'world' });
      const signed = await adapter.getSignedUrl('private/b.pdf', { expiresInSeconds: 2 });
      expect((await adapter.resolveSignedUrl(signed.url))?.body.toString('utf8')).toBe('world');
      now = 7_001;
      expect(await adapter.resolveSignedUrl(signed.url)).toBeNull();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
