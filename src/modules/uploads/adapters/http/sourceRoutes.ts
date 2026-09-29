/**
 * BUG-19 — HTTP routes for the private PDF source lifecycle.
 *
 * Prefix: `/v1/sources`.
 *
 * Implements the two P0 endpoints documented in `docs/backend/API-SURFACE.md`
 * and `contracts/openapi.yaml` that had no runtime implementation:
 *
 *   POST /v1/sources/upload-intents  — reserve a private upload slot
 *   GET  /v1/sources/{sourceId}      — read source processing state
 *
 * The companion write endpoint lives with the rest of the upload surface:
 * `PUT /v1/uploads/sources/{id}/content` (see `modules/uploads/.../routes.ts`),
 * which also enqueues the `source_ingestion` job.
 *
 * Notes:
 *  - `uploadUrl` in the intent response is origin-relative on purpose so the
 *    browser sends it through the BFF and the httpOnly session cookie travels.
 *  - No storage key, signed URL, or byte payload is ever returned here.
 *  - Tenant isolation is enforced at the repository layer via `workspaceId`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ApiError } from '../../../../common/errors/envelope.js';
import type { Database } from '../../../../infrastructure/database/db.js';
import type { SourceExtractionJobsStore } from '../../../sources/domain/SourceExtraction.js';
import { hasPermission } from '../../../auth/policy/Permissions.js';
import { createUploadsService } from '../../application/createUploadsService.js';
import type { SourceUploadsService } from '../../domain/SourceUploadsService.js';
import { SOURCE_UPLOAD_CONTENT_TYPE } from '../../policy/UploadPolicies.js';
import type { AuthenticatedActor } from './routes.js';

export interface RegisterSourceRoutesOptions {
  db?: Database;
  extractionJobsStore?: SourceExtractionJobsStore;
  /**
   * BUG-19: shared uploads service. `/v1/sources/*` and `/v1/uploads/sources/*`
   * MUST use the same service (and therefore the same store + storage adapter),
   * otherwise an intent created here is invisible to the content PUT and every
   * upload fails with 404. Omitted only in isolated unit tests.
   */
  service?: SourceUploadsService;
}

const MAX_FILENAME_BYTES = 200;

/** Wire shape of `GET /v1/sources/{sourceId}` — matches the OpenAPI SourceResponse. */
export type SourceStateDto = {
  id: string;
  type: 'catalog' | 'pdf';
  status: 'uploading' | 'processing' | 'ready' | 'failed' | 'deleted';
  fileName: string;
  pageCount: number | null;
  failureCode: string | null;
};

export async function registerSourceRoutes(
  app: FastifyInstance,
  options: RegisterSourceRoutesOptions = {},
): Promise<void> {
  const service =
    options.service ??
    createUploadsService({
      ...(options.db !== undefined ? { db: options.db } : {}),
    });
  const extractionJobsStore = options.extractionJobsStore;

  app.post('/v1/sources/upload-intents', async (request, reply) => {
    const actor = requireAuthenticated(request);
    requireSourceManage(actor, request);
    const body = (request.body ?? {}) as {
      fileName?: unknown;
      contentType?: unknown;
      sizeBytes?: unknown;
    };

    const fieldErrors: Record<string, string[]> = {};
    const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
    if (fileName.length === 0) {
      fieldErrors['fileName'] = ['Nama berkas wajib diisi.'];
    } else if (Buffer.byteLength(fileName, 'utf8') > MAX_FILENAME_BYTES) {
      fieldErrors['fileName'] = [`Nama berkas maksimal ${MAX_FILENAME_BYTES} byte.`];
    }
    const contentType =
      typeof body.contentType === 'string' ? body.contentType.trim().toLowerCase() : '';
    if (contentType !== SOURCE_UPLOAD_CONTENT_TYPE) {
      fieldErrors['contentType'] = ['Hanya application/pdf yang didukung.'];
    }
    const sizeBytes = Number(body.sizeBytes);
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      fieldErrors['sizeBytes'] = ['Ukuran berkas harus bilangan bulat positif.'];
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'Permintaan tidak valid.',
        requestId: request.requestId ?? 'req_unknown',
        status: 400,
        fieldErrors,
      });
    }

    const result = await service.createIntent({
      workspaceId: actor.workspaceId,
      tenantId: actor.tenantId,
      uploaderUserId: actor.userId,
      filename: fileName,
      contentType,
      declaredByteSize: sizeBytes,
      requestId: request.requestId ?? 'req_unknown',
    });
    // The contract documents 201 for a created intent.
    return reply.status(201).send({ data: result });
  });

  app.get('/v1/sources/:sourceId', async (request) => {
    const actor = requireAuthenticated(request);
    requireSourceManage(actor, request);
    const { sourceId } = request.params as { sourceId: string };
    const requestId = request.requestId ?? 'req_unknown';

    const upload = await service.getRedacted(actor.workspaceId, sourceId, requestId);
    const extraction = extractionJobsStore
      ? await extractionJobsStore.getJobByUploadId(actor.workspaceId, sourceId)
      : null;

    return {
      data: toSourceState(
        sourceId,
        upload.status,
        upload.failureCode,
        upload.filenameRedacted,
        extraction,
      ),
    };
  });
}

/**
 * Map the upload + extraction state onto the wire contract.
 *
 * `uploading`  — intent reserved, bytes not yet stored
 * `processing` — bytes stored, extraction not finished
 * `ready`      — extraction succeeded; usable as a generation source
 * `failed`     — upload rejected or extraction terminally failed
 * `deleted`    — soft-deleted by the owner
 */
export function toSourceState(
  sourceId: string,
  uploadStatus: 'received' | 'verified' | 'rejected' | 'deleted',
  uploadFailureCode: string | null,
  fileName: string,
  extraction:
    | {
        status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
        failureCode: string | null;
        pageCount: number | null;
      }
    | null,
): SourceStateDto {
  const base = {
    id: sourceId,
    type: 'pdf' as const,
    fileName,
    pageCount: null as number | null,
  };

  if (uploadStatus === 'deleted') {
    return { ...base, status: 'deleted', failureCode: null };
  }
  if (uploadStatus === 'rejected') {
    return { ...base, status: 'failed', failureCode: uploadFailureCode ?? 'SOURCE_REJECTED' };
  }
  if (uploadStatus === 'received') {
    // No bytes recorded yet — the client should keep waiting rather than treat
    // this as ready.
    return { ...base, status: 'uploading', failureCode: null };
  }
  if (!extraction) {
    return { ...base, status: 'processing', failureCode: null };
  }
  if (extraction.status === 'succeeded') {
    return { ...base, status: 'ready', pageCount: extraction.pageCount, failureCode: null };
  }
  if (extraction.status === 'failed' || extraction.status === 'cancelled') {
    return {
      ...base,
      status: 'failed',
      failureCode: extraction.failureCode ?? 'EXTRACTION_FAILED',
    };
  }
  return { ...base, status: 'processing', failureCode: null };
}

function requireAuthenticated(request: FastifyRequest): AuthenticatedActor {
  const actor = (request as unknown as { actor?: AuthenticatedActor }).actor;
  if (!actor) {
    throw new ApiError({
      code: 'AUTH_REQUIRED',
      message: 'Autentikasi diperlukan.',
      requestId: request.requestId ?? 'req_unknown',
      status: 401,
    });
  }
  return actor;
}

function requireSourceManage(actor: AuthenticatedActor, request: FastifyRequest): void {
  if (!hasPermission(actor.role, 'source.manage')) {
    throw new ApiError({
      code: 'PERMISSION_DENIED',
      message: 'Permintaan tidak diizinkan.',
      requestId: request.requestId ?? 'req_unknown',
      status: 403,
    });
  }
}
