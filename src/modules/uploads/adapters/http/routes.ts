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
import {
  createStorageAdapter,
  resolveStorageDriver,
} from '../../../../infrastructure/storage/createStorageAdapter.js';
import type { StorageAdapter } from '../../../../infrastructure/storage/StorageAdapter.js';
import { hasPermission } from '../../../auth/policy/Permissions.js';
import { createUploadsService } from '../../application/createUploadsService.js';

export interface RegisterUploadRoutesOptions {
  db?: Database;
  storage?: StorageAdapter;
  /** Hard ceiling for upload size; defaults to env SOURCE_UPLOAD_MAX_BYTES or 50 MiB. */
  maxBytes?: number;
}

const MAX_FILENAME_BYTES = 200;
const MAX_DECLARED_BYTES_VALUE = 1024 * 1024 * 1024;

export async function registerUploadRoutes(
  app: FastifyInstance,
  options: RegisterUploadRoutesOptions = {},
): Promise<void> {
  // Register an octet-stream / pdf parser that returns the raw body buffer so
  // the intake handler can enforce its own size cap rather than relying on
  // Fastify's JSON parser rejecting unknown media types with 415.
  app.addContentTypeParser(
    ['application/pdf', 'application/octet-stream'],
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  const storage = options.storage ?? createStorageAdapter();
  const driverName = resolveStorageDriver();
  const service = createUploadsService({
    storage,
    storageDriverName: driverName,
    ...(options.db !== undefined ? { db: options.db } : {}),
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
  });

  app.post('/v1/uploads/sources/intake', async (request, reply) => {
    const actor = requireAuthenticated(request);
    const workspaceId = workspaceIdOf(request);
    const tenantId = tenantIdOf(request);
    const contentTypeHeader = headerString(request, 'content-type') ?? 'application/pdf';
    const contentType = (contentTypeHeader.split(';')[0] ?? '').trim().toLowerCase();
    const bytes = await readBodyWithCap(request, reply, options.maxBytes);
    const declaredByteSize = bytes.byteLength;
    if (declaredByteSize > (options.maxBytes ?? Number.MAX_SAFE_INTEGER)) {
      throw new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'Ukuran berkas melebihi batas.',
        requestId: request.requestId ?? 'req_unknown',
        status: 413,
      });
    }
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
