/**
 * B2-01 — HTTP routes for the private source PDF upload lifecycle.
 *
 * Prefix: `/v1/uploads/sources`.
 *
 * Notes:
 *  - Routes never include the storage key, signed URL, or byte stream in
 *    responses. The signed intent endpoint (`POST /:id/access`) returns a
 *    short-lived signed URL only to authenticated, authorized callers and
 *    never via logs.
 *  - Tenant isolation is enforced at the repository layer; the handler never
 *    issues a cross-workspace lookup. Caller provides `workspaceId` via header
 *    or session cookie (route handlers accept either for compatibility with
 *    the auth middleware used by other modules).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ApiError } from '../../../../common/errors/envelope.js';
import type { Database } from '../../../../infrastructure/database/db.js';
import type { QueueStore } from '../../../../infrastructure/queue/adapters/queue-store.js';
import { submitJobToStore } from '../../../../infrastructure/queue/application/submitJob.js';
import {
  createStorageAdapter,
  resolveStorageDriver,
} from '../../../../infrastructure/storage/createStorageAdapter.js';
import type { StorageAdapter } from '../../../../infrastructure/storage/StorageAdapter.js';
import { hasPermission } from '../../../auth/policy/Permissions.js';
import { createUploadsService } from '../../application/createUploadsService.js';
import type { SourceUploadsService } from '../../domain/SourceUploadsService.js';
import {
  DEFAULT_SOURCE_UPLOAD_MAX_BYTES,
  SOURCE_UPLOAD_CONTENT_TYPE,
} from '../../policy/UploadPolicies.js';

export interface RegisterUploadRoutesOptions {
  db?: Database;
  storage?: StorageAdapter;
  /** Hard ceiling for upload size; defaults to SOURCE_UPLOAD_MAX_BYTES or 50 MiB. */
  maxBytes?: number;
  /**
   * BUG-19: shared queue store used to enqueue the `source_ingestion` job once
   * the client PUTs the bytes for a reserved intent. Omitted in unit tests and
   * in-memory smoke runs, where extraction is driven directly.
   */
  queueStore?: QueueStore;
  /**
   * BUG-19: shared uploads service. MUST be the same instance used by
   * `registerSourceRoutes`, otherwise an intent created by the intent route is
   * invisible here and every content PUT fails with 404.
   */
  service?: SourceUploadsService;
}

const MAX_FILENAME_BYTES = 200;
const MAX_DECLARED_BYTES_VALUE = 1024 * 1024 * 1024;

export async function registerUploadRoutes(
  app: FastifyInstance,
  options: RegisterUploadRoutesOptions = {},
): Promise<void> {
  // BUG-18: the cap must be a single value shared by the Fastify body limit,
  // the intake handler, and the `maxBytes` echoed on success. Previously the
  // route kept Fastify's 1 MiB default while advertising 50 MiB, so every
  // source PDF above 1 MiB failed with a 500.
  const maxBytes = options.maxBytes ?? DEFAULT_SOURCE_UPLOAD_MAX_BYTES;

  // Register an octet-stream / pdf parser that returns the raw body buffer so
  // the intake handler can enforce its own size cap rather than relying on
  // Fastify's JSON parser rejecting unknown media types with 415.
  app.addContentTypeParser(
    ['application/pdf', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: maxBytes },
    (_request, body, done) => done(null, body),
  );

  // BUG-19: the content PUT must accept the same payload size the intent
  // advertised. Reuses the BUG-18 `maxBytes` value for the parser/body limit.

  const storage = options.storage ?? createStorageAdapter();
  const driverName = resolveStorageDriver();
  const service =
    options.service ??
    createUploadsService({
      storage,
      storageDriverName: driverName,
      maxBytes,
      ...(options.db !== undefined ? { db: options.db } : {}),
    });

  app.post('/v1/uploads/sources/intake', { bodyLimit: maxBytes }, async (request, reply) => {
    const actor = requireAuthenticated(request);
    const workspaceId = workspaceIdOf(request);
    const tenantId = tenantIdOf(request);
    const contentTypeHeader = headerString(request, 'content-type') ?? SOURCE_UPLOAD_CONTENT_TYPE;
    const contentType = (contentTypeHeader.split(';')[0] ?? '').trim().toLowerCase();
    const bytes = await readBodyWithCap(request, reply, maxBytes);
    const declaredByteSize = bytes.byteLength;
    const filename = headerString(request, 'x-source-filename');
    if (filename && Buffer.byteLength(filename, 'utf8') > MAX_FILENAME_BYTES) {
      throw new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'Nama berkas terlalu panjang.',
        requestId: request.requestId ?? 'req_unknown',
        status: 400,
        fieldErrors: { filename: ['Nama berkas maksimal 200 byte.'] },
      });
    }
    const result = await service.intake({
      workspaceId,
      tenantId,
      uploaderUserId: actor.userId,
      filename,
      contentType,
      declaredByteSize,
      bytes,
      requestId: request.requestId ?? 'req_unknown',
    });
    return reply.status(201).send({ data: result });
  });

  app.get('/v1/uploads/sources/:id', async (request) => {
    const actor = requireAuthenticated(request);
    requireSourceManage(actor, request);
    const { id } = request.params as { id: string };
    const workspaceId = workspaceIdOf(request);
    const upload = await service.getRedacted(workspaceId, id, request.requestId ?? 'req_unknown');
    return { data: upload };
  });

  // BUG-19 — write target handed out by `POST /v1/sources/upload-intents`.
  // Idempotent against re-PUT: a second PUT to an already-verified upload is a
  // 409 rather than a silent overwrite.
  app.put('/v1/uploads/sources/:id/content', { bodyLimit: maxBytes }, async (request, reply) => {
    const actor = requireAuthenticated(request);
    requireSourceManage(actor, request);
    const { id } = request.params as { id: string };
    const workspaceId = workspaceIdOf(request);
    const contentTypeHeader = headerString(request, 'content-type') ?? SOURCE_UPLOAD_CONTENT_TYPE;
    const contentType = (contentTypeHeader.split(';')[0] ?? '').trim().toLowerCase();
    const bytes = await readBodyWithCap(request, reply, maxBytes);
    const result = await service.storeContent({
      workspaceId,
      uploadId: id,
      actorUserId: actor.userId,
      contentType,
      bytes,
      requestId: request.requestId ?? 'req_unknown',
    });

    // Enqueue extraction now that real bytes exist. Best-effort: a queue outage
    // must not lose the upload the teacher already transferred, so the row stays
    // `verified` and the client can retry the extraction enqueue.
    if (options.queueStore) {
      try {
        await submitJobToStore(options.queueStore, {
          workspaceId,
          actorId: actor.userId,
          kind: 'source_ingestion',
          idempotencyKey: `source_ingestion:${id}`,
          payload: { sourceId: id, uploadId: id },
          // Extraction belongs to the upload the teacher already paid for; it
          // must not consume an extra generation unit.
          quotaUnits: 0,
        });
      } catch {
        // Swallowed on purpose — see above. The retry path is
        // `POST /v1/sources/{id}/extractions`.
      }
    }

    return { data: result };
  });

  app.post('/v1/uploads/sources/:id/verify', async (request) => {
    const actor = requireAuthenticated(request);
    requireSourceManage(actor, request);
    const { id } = request.params as { id: string };
    const workspaceId = workspaceIdOf(request);
    const result = await service.verify({
      workspaceId,
      uploadId: id,
      actorUserId: actor.userId,
      requestId: request.requestId ?? 'req_unknown',
    });
    return { data: result };
  });

  app.post('/v1/uploads/sources/:id/access', async (request) => {
    const actor = requireAuthenticated(request);
    requireSourceManage(actor, request);
    const { id } = request.params as { id: string };
    const workspaceId = workspaceIdOf(request);
    const intent = await service.grantAccess({
      workspaceId,
      uploadId: id,
      actorUserId: actor.userId,
      requestId: request.requestId ?? 'req_unknown',
    });
    return { data: intent };
  });

  app.post('/v1/uploads/sources/:id/revoke', async (request) => {
    const actor = requireAuthenticated(request);
    requireSourceManage(actor, request);
    const { id } = request.params as { id: string };
    const workspaceId = workspaceIdOf(request);
    await service.revokeAccess({
      workspaceId,
      uploadId: id,
      actorUserId: actor.userId,
      requestId: request.requestId ?? 'req_unknown',
    });
    return { data: { uploadId: id, status: 'revoked' } };
  });

  app.post('/v1/uploads/sources/:id/delete', async (request) => {
    const actor = requireAuthenticated(request);
    requireSourceManage(actor, request);
    const { id } = request.params as { id: string };
    const workspaceId = workspaceIdOf(request);
    const result = await service.delete({
      workspaceId,
      uploadId: id,
      actorUserId: actor.userId,
      requestId: request.requestId ?? 'req_unknown',
    });
    return { data: result };
  });
}

interface AuthenticatedActor {
  userId: string;
  role: 'superadmin' | 'school_admin' | 'teacher' | 'subscriber';
  workspaceId: string;
  tenantId: string;
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

function workspaceIdOf(request: FastifyRequest): string {
  const fromActor = (request as unknown as { actor?: AuthenticatedActor }).actor?.workspaceId;
  if (fromActor) return fromActor;
  const header = headerString(request, 'x-workspace-id');
  if (header) return header;
  throw new ApiError({
    code: 'WORKSPACE_ACCESS_DENIED',
    message: 'Workspace tidak ditemukan.',
    requestId: request.requestId ?? 'req_unknown',
    status: 404,
  });
}

function tenantIdOf(request: FastifyRequest): string {
  const fromActor = (request as unknown as { actor?: AuthenticatedActor }).actor?.tenantId;
  if (fromActor) return fromActor;
  const header = headerString(request, 'x-tenant-id');
  if (header) return header;
  throw new ApiError({
    code: 'WORKSPACE_ACCESS_DENIED',
    message: 'Workspace tidak ditemukan.',
    requestId: request.requestId ?? 'req_unknown',
    status: 404,
  });
}

function headerString(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name];
  if (typeof raw !== 'string') return null;
  return raw.length === 0 ? null : raw;
}

async function readBodyWithCap(
  request: FastifyRequest,
  reply: FastifyReply,
  maxBytes: number | undefined,
): Promise<Buffer> {
  const declared = Number(headerString(request, 'content-length') ?? Number.NaN) || Number.NaN;
  if (maxBytes !== undefined && Number.isFinite(declared) && declared > maxBytes + 1024) {
    throw new ApiError({
      code: 'VALIDATION_FAILED',
      message: 'Ukuran berkas melebihi batas.',
      requestId: request.requestId ?? 'req_unknown',
      status: 413,
    });
  }
  if (Number.isFinite(declared) && declared > MAX_DECLARED_BYTES_VALUE) {
    throw new ApiError({
      code: 'VALIDATION_FAILED',
      message: 'Ukuran berkas melebihi batas.',
      requestId: request.requestId ?? 'req_unknown',
      status: 413,
    });
  }
  // The upload module registers a content-type parser that hands us the raw
  // body buffer directly; fall back to chunk collection for raw stream bodies.
  const body = request.body as unknown;
  if (Buffer.isBuffer(body)) {
    if (maxBytes !== undefined && body.byteLength > maxBytes) {
      throw new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'Ukuran berkas melebihi batas.',
        requestId: request.requestId ?? 'req_unknown',
        status: 413,
      });
    }
    void reply;
    return body;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request.raw) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (maxBytes !== undefined && total > maxBytes) {
      throw new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'Ukuran berkas melebihi batas.',
        requestId: request.requestId ?? 'req_unknown',
        status: 413,
      });
    }
    chunks.push(buf);
  }
  void reply;
  return Buffer.concat(chunks);
}

export type { AuthenticatedActor };

export function makeActorFromAuth(input: {
  userId: string;
  role: AuthenticatedActor['role'];
  workspaceId: string;
  tenantId: string;
}): AuthenticatedActor {
  return {
    userId: input.userId,
    role: input.role,
    workspaceId: input.workspaceId,
    tenantId: input.tenantId,
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: AuthenticatedActor;
  }
}
