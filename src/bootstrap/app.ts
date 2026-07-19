import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';

import { ApiError, buildErrorEnvelope, type StableErrorCode } from '../common/errors/envelope.js';
import { registerRequestId, REQUEST_ID_HEADER } from '../common/middleware/request-id.js';
import { registerJobRoutes } from '../infrastructure/queue/adapters/http/jobRoutes.js';
import type { Database } from '../infrastructure/database/db.js';
import { registerAuthRoutes } from '../modules/auth/adapters/http/routes.js';
import { registerCurriculumRoutes } from '../modules/curriculum/adapters/http/routes.js';
import { registerNotificationRoutes } from '../modules/notifications/adapters/http/routes.js';
import type { AuthService } from '../modules/auth/application/AuthService.js';

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

export interface BuildAppOptions {
  logger?: FastifyServerOptions['logger'];
  serviceName?: string;
  serviceVersion?: string;
  auth?: AuthService;
  curriculumDb?: Database;
  notificationDb?: Database;
}

const DEFAULT_SERVICE_NAME = 'lembar-api';
const DEFAULT_SERVICE_VERSION = '0.0.0-b001';

function envelopeFor(
  status: number,
  code: StableErrorCode,
  message: string,
  requestId: string,
): { status: number; payload: ReturnType<typeof buildErrorEnvelope> } {
  const retryable = status >= 500;
  return {
    status,
    payload: buildErrorEnvelope({
      code,
      message,
      requestId,
      retryable,
    }),
  };
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance<Server, IncomingMessage, ServerResponse>> {
  const app: FastifyInstance<Server, IncomingMessage, ServerResponse> = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: 'info',
            serializers: {
              req: (req) => ({
                method: req.method,
                url: req.url,
                requestId: (req as { requestId?: string }).requestId ?? null,
                redacted: true,
              }),
              res: (res) => ({ statusCode: res.statusCode }),
            },
          },
  });

  registerRequestId(app);

  app.setNotFoundHandler((req, reply) => {
    const id = req.requestId ?? 'req_unknown';
    const { status, payload } = envelopeFor(
      404,
      'RESOURCE_NOT_FOUND',
      'Resource tidak ditemukan.',
      id,
    );
    void reply.header(REQUEST_ID_HEADER, id);
    void reply.status(status).send(payload);
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const id = req.requestId ?? 'req_unknown';
    void reply.header(REQUEST_ID_HEADER, id);
    if (err instanceof ApiError) {
      const { status, payload } = envelopeFor(err.status, err.code, err.message, id);
      void reply.status(status).send(payload);
      return;
    }
    app.log.error({ err: { name: err.name, message: err.message } }, 'unhandled error');
    const { status, payload } = envelopeFor(
      500,
      'INTERNAL_ERROR',
      'Terjadi kesalahan pada server.',
      id,
    );
    void reply.status(status).send(payload);
  });

  const serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
  const serviceVersion = options.serviceVersion ?? DEFAULT_SERVICE_VERSION;
  const startedAt = Date.now();

  app.get('/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      service: serviceName,
      version: serviceVersion,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  });

  await registerAuthRoutes(app, options.auth === undefined ? {} : { auth: options.auth });
  await app.register(registerJobRoutes);
  if (options.curriculumDb) {
    await registerCurriculumRoutes(app, { db: options.curriculumDb });
  }
  await app.register(
    registerNotificationRoutes,
    options.notificationDb ? { db: options.notificationDb } : {},
  );

  return app;
}
