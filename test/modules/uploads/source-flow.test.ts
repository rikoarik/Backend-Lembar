/**
 * BUG-19 — end-to-end evidence for the private PDF source flow.
 *
 * Covers the two endpoints that were documented as P0 but had no runtime
 * implementation, plus the write target they hand out:
 *
 *   POST /v1/sources/upload-intents          → 201 { sourceId, uploadUrl, expiresAt }
 *   GET  /v1/sources/{sourceId}              → 200 { status: uploading|processing|ready }
 *   PUT  /v1/uploads/sources/{id}/content    → 200 { status: verified }
 *
 * The app is built in-process with an in-memory storage adapter and no
 * DATABASE_URL, so the whole flow runs without provisioning Postgres.
 */
import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import { installErrorHandler } from '../../../src/bootstrap/errorHandlers.js';
import { InMemoryAdapter } from '../../../src/infrastructure/storage/InMemoryAdapter.js';
import { registerUploadsAuthHook } from '../../../src/modules/uploads/adapters/http/preHandler.js';
import { registerUploadRoutes } from '../../../src/modules/uploads/adapters/http/routes.js';
import { registerSourceRoutes } from '../../../src/modules/uploads/adapters/http/sourceRoutes.js';
import { createInMemorySourceUploadsService } from '../../../src/modules/uploads/domain/SourceUploadsService.js';
import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';
import { InMemorySourceExtractionJobsStore } from '../../../src/modules/sources/persistence/InMemorySourceExtractionStores.js';
import { PDF_TRAILER_MARKER } from '../../../src/modules/uploads/policy/UploadPolicies.js';

const secret = 'bug19-flow-secret';
const workspaceId = '11111111-1111-4111-8111-111111111111';

/** Minimal byte sequence that satisfies both the `%PDF-` magic and `%%EOF` trailer. */
function makePdf(payload = 'halo dari guru'): Buffer {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'utf8'),
    Buffer.from(`${payload}\n`, 'utf8'),
    Buffer.from(`${PDF_TRAILER_MARKER}\n`, 'utf8'),
  ]);
}

function token(): string {
  return generateJwt(
    { userId: '22222222-2222-4222-8222-222222222222', email: 'guru@test', roles: ['teacher'], workspaceId },
    { secret, expiryDays: 1 },
  );
}

async function makeApp() {
  const app = Fastify();
  const storage = new InMemoryAdapter();
  const extractionJobsStore = new InMemorySourceExtractionJobsStore();
  // One service instance shared by both route modules: the intent route creates
  // the row and the content PUT writes its bytes, so they MUST see the same
  // store. `installErrorHandler` is the production handler — a test-local copy
  // would silently drop `fieldErrors` and hide regressions.
  const service = createInMemorySourceUploadsService({ storage, storageDriverName: 'memory' });
  installErrorHandler(app);
  await registerUploadsAuthHook(app, { jwtSecret: secret });
  await registerSourceRoutes(app, { extractionJobsStore, service });
  await registerUploadRoutes(app, { storage, service });
  return { app, storage, extractionJobsStore };
}

function authed(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${token()}`, ...extra };
}

describe('BUG-19 private PDF source flow', () => {
  let app: Awaited<ReturnType<typeof makeApp>>['app'];
  let storage: Awaited<ReturnType<typeof makeApp>>['storage'];
  let extractionJobsStore: Awaited<ReturnType<typeof makeApp>>['extractionJobsStore'];

  beforeEach(async () => {
    ({ app, storage, extractionJobsStore } = await makeApp());
  });

  it('creates an upload intent and returns an origin-relative uploadUrl', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sources/upload-intents',
      headers: authed({ 'content-type': 'application/json' }),
      payload: { fileName: 'materi.pdf', contentType: 'application/pdf', sizeBytes: 4096 },
    });

    expect(response.statusCode).toBe(201);
    const data = response.json().data as { sourceId: string; uploadUrl: string; expiresAt: string };
    expect(data.sourceId).toMatch(/^[0-9a-f-]{36}$/);
    // Origin-relative on purpose: an absolute backend URL would bypass the BFF
    // and drop the httpOnly session cookie.
    expect(data.uploadUrl).toBe(`/v1/uploads/sources/${data.sourceId}/content`);
    expect(Number.isNaN(Date.parse(data.expiresAt))).toBe(false);
    await app.close();
  });

  it('reports the source as uploading before any bytes arrive', async () => {
    const intent = await app.inject({
      method: 'POST',
      url: '/v1/sources/upload-intents',
      headers: authed({ 'content-type': 'application/json' }),
      payload: { fileName: 'materi.pdf', contentType: 'application/pdf', sizeBytes: 4096 },
    });
    const { sourceId } = intent.json().data as { sourceId: string };

    const state = await app.inject({
      method: 'GET',
      url: `/v1/sources/${sourceId}`,
      headers: authed(),
    });

    expect(state.statusCode).toBe(200);
    expect(state.json().data).toMatchObject({
      id: sourceId,
      type: 'pdf',
      status: 'uploading',
      pageCount: null,
    });
    await app.close();
  });

  it('stores the bytes, marks the upload verified, and moves to processing', async () => {
    const intent = await app.inject({
      method: 'POST',
      url: '/v1/sources/upload-intents',
      headers: authed({ 'content-type': 'application/json' }),
      payload: { fileName: 'materi.pdf', contentType: 'application/pdf', sizeBytes: 4096 },
    });
    const { sourceId, uploadUrl } = intent.json().data as {
      sourceId: string;
      uploadUrl: string;
    };

    const put = await app.inject({
      method: 'PUT',
      url: uploadUrl,
      headers: authed({ 'content-type': 'application/pdf' }),
      payload: makePdf(),
    });

    expect(put.statusCode).toBe(200);
    expect(put.json().data).toMatchObject({
      uploadId: sourceId,
      status: 'verified',
      contentType: 'application/pdf',
    });

    // Bytes really landed in storage under the opaque private key.
    const stored = await storage.getObject(`private/uploads/${sourceId}/v1.pdf`);
    expect(stored.byteSize).toBe(makePdf().byteLength);

    // No extraction job has run yet, so the source is still processing.
    const state = await app.inject({
      method: 'GET',
      url: `/v1/sources/${sourceId}`,
      headers: authed(),
    });
    expect(state.json().data.status).toBe('processing');
    await app.close();
  });

  it('reports ready once extraction succeeds', async () => {
    const intent = await app.inject({
      method: 'POST',
      url: '/v1/sources/upload-intents',
      headers: authed({ 'content-type': 'application/json' }),
      payload: { fileName: 'materi.pdf', contentType: 'application/pdf', sizeBytes: 4096 },
    });
    const { sourceId, uploadUrl } = intent.json().data as {
      sourceId: string;
      uploadUrl: string;
    };
    await app.inject({
      method: 'PUT',
      url: uploadUrl,
      headers: authed({ 'content-type': 'application/pdf' }),
      payload: makePdf(),
    });

    const job = await extractionJobsStore.createJob({ uploadId: sourceId, workspaceId });
    await extractionJobsStore.updateJob({
      id: job.id,
      status: 'succeeded',
      pageCount: 3,
      passageCount: 4,
    });

    const state = await app.inject({
      method: 'GET',
      url: `/v1/sources/${sourceId}`,
      headers: authed(),
    });
    expect(state.json().data).toMatchObject({ status: 'ready', pageCount: 3 });
    await app.close();
  });

  it('surfaces a failed extraction with its failure code', async () => {
    const intent = await app.inject({
      method: 'POST',
      url: '/v1/sources/upload-intents',
      headers: authed({ 'content-type': 'application/json' }),
      payload: { fileName: 'materi.pdf', contentType: 'application/pdf', sizeBytes: 4096 },
    });
    const { sourceId, uploadUrl } = intent.json().data as { sourceId: string; uploadUrl: string };
    await app.inject({
      method: 'PUT',
      url: uploadUrl,
      headers: authed({ 'content-type': 'application/pdf' }),
      payload: makePdf(),
    });

    const job = await extractionJobsStore.createJob({ uploadId: sourceId, workspaceId });
    await extractionJobsStore.updateJob({
      id: job.id,
      status: 'failed',
      failureCode: 'IMAGE_ONLY_OR_ENCRYPTED',
    });

    const state = await app.inject({
      method: 'GET',
      url: `/v1/sources/${sourceId}`,
      headers: authed(),
    });
    expect(state.json().data).toMatchObject({
      status: 'failed',
      failureCode: 'IMAGE_ONLY_OR_ENCRYPTED',
    });
    await app.close();
  });

  describe('validation', () => {
    it('rejects a non-PDF content type on the intent with 400 + fieldErrors', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/sources/upload-intents',
        headers: authed({ 'content-type': 'application/json' }),
        payload: { fileName: 'a.txt', contentType: 'text/plain', sizeBytes: 10 },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.fieldErrors).toHaveProperty('contentType');
      await app.close();
    });

    it('rejects a zero size on the intent', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/sources/upload-intents',
        headers: authed({ 'content-type': 'application/json' }),
        payload: { fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 0 },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.fieldErrors).toHaveProperty('sizeBytes');
      await app.close();
    });

    it('rejects bytes that are not a PDF on the content PUT', async () => {
      const intent = await app.inject({
        method: 'POST',
        url: '/v1/sources/upload-intents',
        headers: authed({ 'content-type': 'application/json' }),
        payload: { fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 4096 },
      });
      const { uploadUrl } = intent.json().data as { uploadUrl: string };

      const put = await app.inject({
        method: 'PUT',
        url: uploadUrl,
        headers: authed({ 'content-type': 'application/pdf' }),
        payload: Buffer.from('ini bukan pdf sama sekali'),
      });
      expect(put.statusCode).toBe(415);
      await app.close();
    });

    it('rejects a second PUT to an already-verified upload with 409', async () => {
      const intent = await app.inject({
        method: 'POST',
        url: '/v1/sources/upload-intents',
        headers: authed({ 'content-type': 'application/json' }),
        payload: { fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 4096 },
      });
      const { uploadUrl } = intent.json().data as { uploadUrl: string };
      const first = await app.inject({
        method: 'PUT',
        url: uploadUrl,
        headers: authed({ 'content-type': 'application/pdf' }),
        payload: makePdf(),
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'PUT',
        url: uploadUrl,
        headers: authed({ 'content-type': 'application/pdf' }),
        payload: makePdf('payload kedua'),
      });
      expect(second.statusCode).toBe(409);
      await app.close();
    });
  });

  describe('tenant isolation and auth', () => {
    it('requires a JWT on the intent route', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/sources/upload-intents',
        headers: { 'content-type': 'application/json' },
        payload: { fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      });
      expect(response.statusCode).toBe(401);
      await app.close();
    });

    it('requires a JWT on the source state route', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/sources/${workspaceId}`,
      });
      expect(response.statusCode).toBe(401);
      await app.close();
    });

    it('returns 404 for a source owned by another workspace', async () => {
      const intent = await app.inject({
        method: 'POST',
        url: '/v1/sources/upload-intents',
        headers: authed({ 'content-type': 'application/json' }),
        payload: { fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 4096 },
      });
      const { sourceId } = intent.json().data as { sourceId: string };

      const otherWorkspaceToken = generateJwt(
        {
          userId: '33333333-3333-4333-8333-333333333333',
          email: 'lain@test',
          roles: ['teacher'],
          workspaceId: '99999999-9999-4999-8999-999999999999',
        },
        { secret, expiryDays: 1 },
      );
      const response = await app.inject({
        method: 'GET',
        url: `/v1/sources/${sourceId}`,
        headers: { authorization: `Bearer ${otherWorkspaceToken}` },
      });
      expect(response.statusCode).toBe(404);
      await app.close();
    });
  });
});
