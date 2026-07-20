/**
 * B2-01 — Private source PDF upload lifecycle evidence.
 *
 * Service-level tests that exercise the in-memory stack end-to-end. The test
 * surface covers the three registry-evidence items:
 *   - magic-byte + size policy (magic-size-check)
 *   - cross-tenant IDOR rejection at the repository (cross-tenant-signed-URL)
 *   - signed-URL redaction and audit chain (redaction)
 *
 * The full HTTP/route envelope is exercised in `routes.test.ts` (DB-backed);
 * here we keep the surface tight and DB-free so the lifecycle invariants are
 * always runnable without provisioning Postgres.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { InMemoryAdapter } from '../../../src/infrastructure/storage/InMemoryAdapter.js';
import { createInMemorySourceUploadsService } from '../../../src/modules/uploads/domain/SourceUploadsService.js';
import {
  DEFAULT_SOURCE_UPLOAD_MAX_BYTES,
  PDF_MAGIC_PREFIX,
  PDF_TRAILER_MARKER,
  SOURCE_UPLOAD_CONTENT_TYPE,
} from '../../../src/modules/uploads/policy/UploadPolicies.js';

const TENANT_A = 'tenant_alpha';
const _TENANT_B = 'tenant_beta';
const WORKSPACE_A = 'workspace_alpha_1';
const WORKSPACE_B = 'workspace_beta_1';
const UPLOADER = 'user_alpha_1';
const REQUEST_ID = 'req_test_b201';

/** Build a tiny-but-valid PDF byte buffer that satisfies both magic + trailer. */
function makePdfBytes(payload = 'hello'): Buffer {
  const head = Buffer.concat([PDF_MAGIC_PREFIX, Buffer.from(` ${payload}`, 'utf8')]);
  const tail = Buffer.concat([Buffer.from('\n', 'utf8'), Buffer.from(PDF_TRAILER_MARKER, 'utf8')]);
  return Buffer.concat([head, tail]);
}

describe('B2-01 private source PDF upload lifecycle', () => {
  let storage: InMemoryAdapter;
  let service: ReturnType<typeof createInMemorySourceUploadsService>;

  beforeEach(() => {
    storage = new InMemoryAdapter();
    service = createInMemorySourceUploadsService({
      storage,
      storageDriverName: 'memory',
    });
  });

  describe('magic + size policy', () => {
    it('accepts a buffer that satisfies the %PDF- prefix and %%EOF trailer', async () => {
      const result = await service.intake({
        workspaceId: WORKSPACE_A,
        tenantId: TENANT_A,
        uploaderUserId: UPLOADER,
        filename: null,
        contentType: SOURCE_UPLOAD_CONTENT_TYPE,
        declaredByteSize: 0,
        bytes: makePdfBytes('accept'),
        requestId: REQUEST_ID,
      });
      expect(result.status).toBe('received');
      expect(result.contentType).toBe(SOURCE_UPLOAD_CONTENT_TYPE);
      expect(result.byteSize).toBeGreaterThan(0);
      expect(result.maxBytes).toBe(DEFAULT_SOURCE_UPLOAD_MAX_BYTES);
    });

    it('rejects a non-PDF declared content type with VALIDATION_FAILED', async () => {
      await expect(
        service.intake({
          workspaceId: WORKSPACE_A,
          tenantId: TENANT_A,
          uploaderUserId: UPLOADER,
          filename: 'plain.txt',
          contentType: 'text/plain',
          declaredByteSize: 0,
          bytes: makePdfBytes(),
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
    });

    it('rejects payloads exceeding the max-bytes policy with a 413-shaped error', async () => {
      const oversize = Buffer.alloc(DEFAULT_SOURCE_UPLOAD_MAX_BYTES + 1, 0);
      await expect(
        service.intake({
          workspaceId: WORKSPACE_A,
          tenantId: TENANT_A,
          uploaderUserId: UPLOADER,
          filename: null,
          contentType: SOURCE_UPLOAD_CONTENT_TYPE,
          declaredByteSize: oversize.byteLength,
          bytes: oversize,
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 413 });
    });

    it('writes an intake audit row for every state transition (success or failure)', async () => {
      const ok = await service.intake({
        workspaceId: WORKSPACE_A,
        tenantId: TENANT_A,
        uploaderUserId: UPLOADER,
        filename: null,
        contentType: SOURCE_UPLOAD_CONTENT_TYPE,
        declaredByteSize: 0,
        bytes: makePdfBytes('audit'),
        requestId: REQUEST_ID,
      });
      const audits = await service.listAudit(ok.uploadId);
      expect(audits.length).toBeGreaterThanOrEqual(1);
      expect(audits[0]?.action).toBe('intake');
      expect(audits[0]?.success).toBe(true);
    });
  });

  describe('cross-tenant IDOR rejection', () => {
    it('never returns 403 for a foreign upload id; surfaces RESOURCE_NOT_FOUND (404)', async () => {
      const intake = await service.intake({
        workspaceId: WORKSPACE_A,
        tenantId: TENANT_A,
        uploaderUserId: UPLOADER,
        filename: null,
        contentType: SOURCE_UPLOAD_CONTENT_TYPE,
        declaredByteSize: 0,
        bytes: makePdfBytes('cross'),
        requestId: REQUEST_ID,
      });
      await service.verify({
        workspaceId: WORKSPACE_A,
        uploadId: intake.uploadId,
        actorUserId: UPLOADER,
        requestId: REQUEST_ID,
      });

      // Foreign workspace attempts every protected read/write.
      await expect(
        service.getRedacted(WORKSPACE_B, intake.uploadId, REQUEST_ID),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });

      await expect(
        service.grantAccess({
          workspaceId: WORKSPACE_B,
          uploadId: intake.uploadId,
          actorUserId: 'attacker',
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });

      await expect(
        service.delete({
          workspaceId: WORKSPACE_B,
          uploadId: intake.uploadId,
          actorUserId: 'attacker',
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('foreign workspace cannot read redacted metadata even after the upload is deleted', async () => {
      const intake = await service.intake({
        workspaceId: WORKSPACE_A,
        tenantId: TENANT_A,
        uploaderUserId: UPLOADER,
        filename: null,
        contentType: SOURCE_UPLOAD_CONTENT_TYPE,
        declaredByteSize: 0,
        bytes: makePdfBytes('delete-cross'),
        requestId: REQUEST_ID,
      });
      await service.verify({
        workspaceId: WORKSPACE_A,
        uploadId: intake.uploadId,
        actorUserId: UPLOADER,
        requestId: REQUEST_ID,
      });
      await service.delete({
        workspaceId: WORKSPACE_A,
        uploadId: intake.uploadId,
        actorUserId: UPLOADER,
        requestId: REQUEST_ID,
      });

      await expect(
        service.getRedacted(WORKSPACE_B, intake.uploadId, REQUEST_ID),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('redaction: signed access never leaks storage key or URL', () => {
    it('grantAccess returns only the upload id, workspace, expiry, and a 12-char fingerprint', async () => {
      const intake = await service.intake({
        workspaceId: WORKSPACE_A,
        tenantId: TENANT_A,
        uploaderUserId: UPLOADER,
        filename: null,
        contentType: SOURCE_UPLOAD_CONTENT_TYPE,
        declaredByteSize: 0,
        bytes: makePdfBytes('access'),
        requestId: REQUEST_ID,
      });
      await service.verify({
        workspaceId: WORKSPACE_A,
        uploadId: intake.uploadId,
        actorUserId: UPLOADER,
        requestId: REQUEST_ID,
      });

      const intent = await service.grantAccess({
        workspaceId: WORKSPACE_A,
        uploadId: intake.uploadId,
        actorUserId: UPLOADER,
        requestId: REQUEST_ID,
      });

      expect(Object.keys(intent).sort()).toEqual(
        ['expiresAtEpochMs', 'signedUrlFingerprint', 'uploadId', 'workspaceId'].sort(),
      );
      expect(intent.signedUrlFingerprint).toHaveLength(12);
      // No key, no URL, no storage hint ever leaves the service.
      const serialized = JSON.stringify(intent);
      expect(serialized).not.toMatch(/private\/uploads/);
      expect(serialized).not.toMatch(/v1\.pdf/);
      expect(serialized).not.toMatch(/key=/);
      expect(serialized).not.toMatch(/sig=/);
      expect(serialized).not.toMatch(/[?&]expires=/);
    });

    it('access grant requires verified status; received uploads return STATE_CONFLICT', async () => {
      const intake = await service.intake({
        workspaceId: WORKSPACE_A,
        tenantId: TENANT_A,
        uploaderUserId: UPLOADER,
        filename: null,
        contentType: SOURCE_UPLOAD_CONTENT_TYPE,
        declaredByteSize: 0,
        bytes: makePdfBytes('premature'),
        requestId: REQUEST_ID,
      });
      await expect(
        service.grantAccess({
          workspaceId: WORKSPACE_A,
          uploadId: intake.uploadId,
          actorUserId: UPLOADER,
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT', status: 409 });
    });

    it('audit chain survives delete and never includes storage key or signed URL', async () => {
      const intake = await service.intake({
        workspaceId: WORKSPACE_A,
        tenantId: TENANT_A,
        uploaderUserId: UPLOADER,
        filename: 'source.pdf',
        contentType: SOURCE_UPLOAD_CONTENT_TYPE,
        declaredByteSize: 0,
        bytes: makePdfBytes('chain'),
        requestId: REQUEST_ID,
      });
      await service.verify({
        workspaceId: WORKSPACE_A,
        uploadId: intake.uploadId,
        actorUserId: UPLOADER,
        requestId: REQUEST_ID,
      });
      await service.delete({
        workspaceId: WORKSPACE_A,
        uploadId: intake.uploadId,
        actorUserId: UPLOADER,
        requestId: REQUEST_ID,
      });

      const audits = await service.listAudit(intake.uploadId);
      const actions = audits.map((row) => row.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'intake',
          'magic_check',
          'size_check',
          'delete_request',
          'delete_complete',
        ]),
      );

      // Redaction invariants: storage key + URL must never appear in audit rows.
      const allAuditText = JSON.stringify(audits);
      expect(allAuditText).not.toMatch(/private\/uploads/);
      expect(allAuditText).not.toMatch(/v1\.pdf/);
      expect(allAuditText).not.toMatch(/key=/);
      expect(allAuditText).not.toMatch(/sig=/);
      expect(allAuditText).not.toMatch(/source\.pdf/);
    });

    it('delete returns bytesRemoved=true and tombstone status, with no bytes retained in storage', async () => {
      const intake = await service.intake({
        workspaceId: WORKSPACE_A,
        tenantId: TENANT_A,
        uploaderUserId: UPLOADER,
        filename: null,
        contentType: SOURCE_UPLOAD_CONTENT_TYPE,
        declaredByteSize: 0,
        bytes: makePdfBytes('purge'),
        requestId: REQUEST_ID,
      });
      await service.verify({
        workspaceId: WORKSPACE_A,
        uploadId: intake.uploadId,
        actorUserId: UPLOADER,
        requestId: REQUEST_ID,
      });
      const result = await service.delete({
        workspaceId: WORKSPACE_A,
        uploadId: intake.uploadId,
        actorUserId: UPLOADER,
        requestId: REQUEST_ID,
      });
      expect(result.status).toBe('deleted');
      expect(result.bytesRemoved).toBe(true);

      // Tombstone row still readable in workspace; storage layer no longer holds the bytes.
      const tombstone = await service.getRedacted(WORKSPACE_A, intake.uploadId, REQUEST_ID);
      expect(tombstone.status).toBe('deleted');
      await expect(
        storage.headObject(`private/uploads/${intake.uploadId}/v1.pdf`),
      ).rejects.toBeDefined();
    });
  });
});
