import { describe, expect, it } from 'vitest';

import { ExportPdfHandler } from '../../../src/infrastructure/queue/handlers/ExportPdfHandler.js';
import { StubHtmlToPdfAdapter } from '../../../src/infrastructure/pdf/StubHtmlToPdfAdapter.js';

function makeContext(overrides: Record<string, unknown> = {}) {
  const controller = new AbortController();
  return {
    jobId: 'job-1',
    workspaceId: 'ws-1',
    actorId: 'user-1',
    attempt: 1,
    signal: controller.signal,
    payload: {
      assessmentId: 'assess-abc',
      exportId: 'export-xyz',
      ...overrides,
    },
  };
}

describe('ExportPdfHandler', () => {
  it('mengembalikan status sukses dengan bytes nyata dari renderer', async () => {
    const adapter = new StubHtmlToPdfAdapter();
    const handler = new ExportPdfHandler(adapter);
    const result = await handler.handle(makeContext());

    expect(result.status).toBe('success');
    expect(result.output?.assessmentId).toBe('assess-abc');
    expect(result.output?.exportId).toBe('export-xyz');
    expect(result.output?.format).toBe('pdf');
    expect(result.output?.mediaType).toBe('application/pdf');
    // sizeBytes harus nyata (> 0), bukan nilai hardcoded 245678
    expect(typeof result.output?.sizeBytes).toBe('number');
    expect(result.output?.sizeBytes as number).toBeGreaterThan(0);
    expect(result.output?.sizeBytes as number).not.toBe(245678);
    expect(typeof result.output?.checksumSha256).toBe('string');
    expect(result.output?.rendererVersion).toBeTruthy();
  });

  it('mengembalikan failure dengan kode CANCELLED ketika sinyal dibatalkan', async () => {
    const adapter = new StubHtmlToPdfAdapter();
    const handler = new ExportPdfHandler(adapter);
    const controller = new AbortController();
    const ctx = {
      jobId: 'job-2',
      workspaceId: 'ws-2',
      actorId: 'user-2',
      attempt: 1,
      signal: controller.signal,
      payload: { assessmentId: 'a', exportId: 'e' },
    };
    controller.abort();
    const result = await handler.handle(ctx);

    expect(result.status).toBe('failure');
    expect(result.error?.code).toBe('CANCELLED');
  });

  it('mengembalikan failure dengan kode EXPORT_ERROR jika renderer melempar error', async () => {
    const failingAdapter = {
      async renderPdf(): Promise<never> {
        throw new Error('renderer gagal');
      },
    };
    const handler = new ExportPdfHandler(failingAdapter);
    const result = await handler.handle(makeContext());

    expect(result.status).toBe('failure');
    expect(result.error?.code).toBe('EXPORT_ERROR');
    expect(result.error?.message).toContain('renderer gagal');
  });
});
