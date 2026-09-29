/**
 * BUG-22 — intake/verify must validate the PDF *content*, not the client's
 * `content-type` header.
 *
 * Live evidence before the fix (BE 127.0.0.1:4000, `POST /v1/uploads/sources/intake`):
 *   - `"hello not a pdf"` (15 B) + `content-type: application/pdf` → 201 `received`
 *   - `"JUST TEXT"×10` + `content-type: application/pdf`      → 201 `received`
 *   - then `POST …/verify` on the 15-byte text file           → 200 `verified`
 *
 * A `content-type` header is client-controlled and proves nothing about the
 * payload, so garbage could reach the generate stage via `sourceMode=pdf`. The
 * HTTP-level contract is exercised in `intake-content.test.ts`; here we pin the
 * service-level rule (and the audit trail) so the invariant survives refactors.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryAdapter } from '../../../src/infrastructure/storage/InMemoryAdapter.js';
import {
  createInMemorySourceUploadsService,
  hasPdfTrailer,
  isPdfPayload,
  looksLikePdfMagic,
  SourceUploadsService,
} from '../../../src/modules/uploads/domain/SourceUploadsService.js';
import { InMemorySourceUploadsStore } from '../../../src/modules/uploads/persistence/InMemorySourceUploadsStore.js';
import {
  PDF_MAGIC_PREFIX,
  PDF_TRAILER_MARKER,
  SOURCE_UPLOAD_CONTENT_TYPE,
} from '../../../src/modules/uploads/policy/UploadPolicies.js';

const TENANT = 'tenant_alpha';
const WORKSPACE = 'workspace_alpha_1';
const UPLOADER = 'user_alpha_1';
const REQUEST_ID = 'req_test_bug22';

/** A byte-exact minimal PDF that satisfies both the magic prefix and trailer. */
function makePdfBytes(payload = 'hello'): Buffer {
  return Buffer.concat([
    PDF_MAGIC_PREFIX,
    Buffer.from(` ${payload}`, 'utf8'),
    Buffer.from(`\n${PDF_TRAILER_MARKER}`, 'utf8'),
  ]);
}

/** The exact live-failure payload: 15 bytes of plain text. */
const TEXT_BODY = Buffer.from('hello not a pdf', 'utf8');

describe('BUG-22 PDF content validation', () => {
  let storage: InMemoryAdapter;
  let service: ReturnType<typeof createInMemorySourceUploadsService>;

  beforeEach(() => {
    storage = new InMemoryAdapter();
    service = createInMemorySourceUploadsService({
      storage,
      storageDriverName: 'memory',
    });
  });

  function intake(bytes: Buffer, contentType = SOURCE_UPLOAD_CONTENT_TYPE) {
    return service.intake({
      workspaceId: WORKSPACE,
      tenantId: TENANT,
      uploaderUserId: UPLOADER,
      filename: null,
      contentType,
      declaredByteSize: bytes.byteLength,
      bytes,
      requestId: REQUEST_ID,
    });
  }

  describe('predicates', () => {
    it('requires BOTH the %PDF- header and the %%EOF trailer', () => {
      expect(isPdfPayload(makePdfBytes())).toBe(true);
      // Header only — a text file that happens to start with the marker.
      expect(looksLikePdfMagic(Buffer.from('%PDF- then plain text', 'utf8'))).toBe(true);
      expect(hasPdfTrailer(Buffer.from('%PDF- then plain text', 'utf8'))).toBe(false);
      expect(isPdfPayload(Buffer.from('%PDF- then plain text', 'utf8'))).toBe(false);
      // Trailer only.
      expect(isPdfPayload(Buffer.from('plain text %%EOF', 'utf8'))).toBe(false);
      // Neither.
      expect(isPdfPayload(TEXT_BODY)).toBe(false);
      expect(isPdfPayload(Buffer.alloc(0))).toBe(false);
    });
  });

  describe('intake', () => {
    it('rejects a text body sent as application/pdf with 415 and writes nothing', async () => {
      const putSpy = vi.spyOn(storage, 'putObject');

      await expect(intake(TEXT_BODY)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        status: 415,
      });

      // The bytes must never reach storage: a rejected body leaves no object
      // and no upload row, so it cannot be promoted later by `verify`.
      expect(putSpy).not.toHaveBeenCalled();
      await expect(
        service.listRedacted(WORKSPACE, { limit: 10 }, REQUEST_ID),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('rejects the live "JUST TEXT"x10 payload too', async () => {
      await expect(intake(Buffer.from('JUST TEXT'.repeat(10), 'utf8'))).rejects.toMatchObject({
        status: 415,
      });
    });

    it('audits the rejected intake with failureCode not_a_pdf and no upload id', async () => {
      const store = new InMemorySourceUploadsStore();
      const spy = vi.spyOn(store, 'appendAudit');
      const svc = new SourceUploadsService({
        store,
        storage: new InMemoryAdapter(),
        storageDriverName: 'memory',
      });

      await expect(
        svc.intake({
          workspaceId: WORKSPACE,
          tenantId: TENANT,
          uploaderUserId: UPLOADER,
          filename: null,
          contentType: SOURCE_UPLOAD_CONTENT_TYPE,
          declaredByteSize: TEXT_BODY.byteLength,
          bytes: TEXT_BODY,
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ status: 415 });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toMatchObject({
        uploadId: null,
        workspaceId: WORKSPACE,
        action: 'magic_check',
        success: false,
        failureCode: 'not_a_pdf',
      });
    });

    it('still accepts a valid PDF', async () => {
      const result = await intake(makePdfBytes('ok'));
      expect(result.status).toBe('received');
      expect(result.contentType).toBe(SOURCE_UPLOAD_CONTENT_TYPE);
    });
  });

  describe('verify', () => {
    it('rejects a stored non-PDF and marks the upload rejected', async () => {
      // Simulate a row that reached storage before the intake check existed:
      // bypass the service and write the object + row directly.
      const store = new InMemorySourceUploadsStore();
      const svc = new SourceUploadsService({ store, storage, storageDriverName: 'memory' });
      const uploadId = '00000000-0000-4000-8000-0000000000b1';
      const stored = await storage.putObject({
        key: `private/uploads/${uploadId}/v1.pdf`,
        body: TEXT_BODY,
        contentType: SOURCE_UPLOAD_CONTENT_TYPE,
      });
      await store.insertUpload({
        id: uploadId,
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        uploaderUserId: UPLOADER,
        filenameRedacted: '[redacted-filename]',
        contentType: SOURCE_UPLOAD_CONTENT_TYPE,
        byteSize: stored.byteSize,
        status: 'received',
        currentVersion: 1,
      });
      await store.insertVersion({
        uploadId,
        version: 1,
        storageDriver: 'memory',
        storageKey: stored.key,
        contentHash: stored.checksumSha256,
        redactionClassification: 'pending_review',
      });

      await expect(
        svc.verify({
          workspaceId: WORKSPACE,
          uploadId,
          actorUserId: UPLOADER,
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 415 });

      // The row must not be left readable as `verified`.
      const row = await svc.getRedacted(WORKSPACE, uploadId, REQUEST_ID);
      expect(row.status).toBe('rejected');
      expect(row.failureCode).toBe('not_a_pdf');
    });

    it('accepts a stored valid PDF and returns its content hash', async () => {
      const intakeResult = await intake(makePdfBytes('verify-ok'));
      const verified = await service.verify({
        workspaceId: WORKSPACE,
        uploadId: intakeResult.uploadId,
        actorUserId: UPLOADER,
        requestId: REQUEST_ID,
      });
      expect(verified.status).toBe('verified');
      expect(verified.magicSignature).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
