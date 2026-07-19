import type { FastifyPluginAsync } from 'fastify';

import { ApiError } from '../../../../common/errors/envelope.js';
import { REQUEST_ID_HEADER } from '../../../../common/middleware/request-id.js';
import { parseCurriculumEnv } from '../../../../config/curriculum.env.js';
import { MemoryNotificationAdapter } from '../../domain/NotificationAdapter.js';
import { NotificationService } from '../../domain/NotificationService.js';
import {
  NotificationRepository,
  type NotificationDb,
} from '../../persistence/NotificationRepository.js';
import { parseDispatchBody, type DispatchResponseBody } from './schema.js';

const STUB_BEARER_ENV = 'NOTIFICATIONS_STUB_BEARER';

export interface RegisterNotificationRoutesOptions {
  db?: NotificationDb;
}

export const registerNotificationRoutes: FastifyPluginAsync<
  RegisterNotificationRoutesOptions
> = async (app, rawOptions) => {
  const options: RegisterNotificationRoutesOptions = rawOptions ?? {};
  const adapter = new MemoryNotificationAdapter();

  app.get('/v1/notifications/templates', async (request) => {
    const repo = new NotificationRepository(requireDb(options, request));
    const rows = await repo.listTemplates();
    return {
      data: rows.map((r) => ({
        templateKey: r.templateKey,
        locale: r.locale,
        version: r.version,
        subject: r.subject,
      })),
    };
  });

  app.get('/v1/notifications/templates/:templateKey', async (request, reply) => {
    const { templateKey } = request.params as { templateKey: string };
    const repo = new NotificationRepository(requireDb(options, request));
    const rows = await repo.listTemplateVariants(templateKey);
    if (rows.length === 0) {
      throw new ApiError({
        code: 'RESOURCE_NOT_FOUND',
        message: 'Template tidak ditemukan.',
        requestId: request.requestId ?? 'req_unknown',
        status: 404,
      });
    }
    void reply.header(REQUEST_ID_HEADER, request.requestId ?? 'req_unknown');
    return {
      data: rows.map((row) => ({
        templateKey: row.templateKey,
        locale: row.locale,
        version: row.version,
        subject: row.subject,
        bodyText: row.bodyText,
      })),
    };
  });

  app.post('/v1/notifications/dispatch', async (request, reply) => {
    requireBearer(request);
    const body = parseDispatchBody(request);
    const db = requireDb(options, request);
    const service = new NotificationService({
      adapter,
      repository: new NotificationRepository(db),
    });
    const result = await service.dispatch({
      templateKey: body.templateKey,
      locale: body.locale ?? 'id-ID',
      recipient: body.recipient,
      payload: body.payload,
      eventId: body.eventId,
      ...(body.visibleAt !== undefined ? { visibleAt: new Date(body.visibleAt) } : {}),
    });
    const payload: DispatchResponseBody = {
      data: {
        status: result.status,
        outboxId: result.outboxId,
        locale: result.locale,
        redactedRecipient: result.redactedRecipient,
        subjectHash: result.subjectHash,
      },
    };
    const status = result.status === 'rejected' ? 404 : 200;
    void reply.header(REQUEST_ID_HEADER, request.requestId ?? 'req_unknown');
    return reply.status(status).send(payload);
  });

  app.get('/v1/notifications/audit', async (request, reply) => {
    const repo = new NotificationRepository(requireDb(options, request));
    const rows = await repo.listAudit(100);
    void reply.header(REQUEST_ID_HEADER, request.requestId ?? 'req_unknown');
    return { data: rows };
  });
};

function requireDb(
  options: RegisterNotificationRoutesOptions,
  request: { requestId?: string },
): NotificationDb {
  if (!options.db) {
    throw new ApiError({
      code: 'INTERNAL_ERROR',
      message: 'Notification storage belum dikonfigurasi.',
      requestId: request.requestId ?? 'req_unknown',
      status: 500,
    });
  }
  return options.db;
}

function requireBearer(request: { headers: Record<string, unknown>; requestId?: string }): void {
  const auth = request.headers['authorization'];
  const headerValue = typeof auth === 'string' ? auth : Array.isArray(auth) ? auth[0] : undefined;
  const token = headerValue?.startsWith('Bearer ')
    ? headerValue.slice('Bearer '.length).trim()
    : '';
  const expected = parseStubBearer();
  const allowed = token.length > 0 && (expected === null || token === expected);
  if (!allowed) {
    throw new ApiError({
      code: 'AUTH_REQUIRED',
      message: 'Autentikasi diperlukan.',
      requestId: request.requestId ?? 'req_unknown',
      status: 401,
    });
  }
}

function parseStubBearer(): string | null {
  // Reuse parseCurriculumEnv to honor the same stub-bearer seam; if the env
  // defines CURRICULUM_WRITE_TOKEN the bearer check uses that token for parity.
  // Otherwise fall back to a dedicated notifications stub bearer if provided.
  const direct = process.env[STUB_BEARER_ENV]?.trim();
  if (direct && direct.length > 0) return direct;
  try {
    return parseCurriculumEnv(process.env).bearerToken;
  } catch {
    return null;
  }
}
