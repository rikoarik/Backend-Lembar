import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';

import { ApiError, buildErrorEnvelope, type StableErrorCode } from '../common/errors/envelope.js';
import { registerRequestId, REQUEST_ID_HEADER } from '../common/middleware/request-id.js';
import { parseDatabaseEnv } from '../config/database.env.js';
import { parseQueueEnv } from '../config/queue.env.js';
import { closeDatabase, createDatabase, type Database } from '../infrastructure/database/db.js';
import { registerJobRoutes } from '../infrastructure/queue/adapters/http/jobRoutes.js';
import { registerAuthRoutes } from '../modules/auth/adapters/http/routes.js';
import { registerJwtMultiRoleRoutes } from '../modules/auth/adapters/http/jwtMultiRoleRoutes.js';
import { registerCurriculumRoutes } from '../modules/curriculum/adapters/http/routes.js';
import { registerMarketingRoutes } from '../modules/marketing/adapters/http/routes.js';
import { registerMarketingOpsRoutes } from '../modules/marketing/adapters/http/opsRoutes.js';
import { registerNotificationRoutes } from '../modules/notifications/adapters/http/routes.js';
import { registerUploadRoutes } from '../modules/uploads/adapters/http/routes.js';
import { registerUploadsAuthHook } from '../modules/uploads/adapters/http/preHandler.js';
import type { AuthService } from '../modules/auth/application/AuthService.js';

// B2-05: Job status and recovery routes
import { InMemoryQueueStore } from '../infrastructure/queue/adapters/memory-store.js';
import { QueueJobStatusAdapter } from '../modules/jobs/adapters/QueueJobStatusAdapter.js';
import { JobStatusService } from '../modules/jobs/application/JobStatusService.js';
import { registerJobStatusRoutes } from '../modules/jobs/adapters/http/routes.js';
import { QuotaLedger } from '../modules/quota/application/QuotaLedger.js';
import { QuotaReservationRepository } from '../modules/quota/persistence/repository.js';

// Swagger
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'yaml';

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
  authDb?: Database;
  curriculumDb?: Database;
  marketingDb?: Database;
  notificationDb?: Database;
  uploadsDb?: Database;
  quotaDb?: Database;
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

  // Register Swagger if enabled
  const swaggerEnabled = process.env.SWAGGER_ENABLED === 'true';
  if (swaggerEnabled) {
    try {
      const openapiPath = resolve(process.cwd(), 'contracts/openapi.yaml');
      const openapiContent = readFileSync(openapiPath, 'utf-8');
      const openapiSpec = yaml.parse(openapiContent);
      await app.register(swagger, {
        mode: 'static',
        specification: {
          document: openapiSpec,
        },
      });
      await app.register(swaggerUi, {
        routePrefix: '/docs',
      });
      app.log.info('Swagger UI registered at /docs');
    } catch (err) {
      app.log.error({ err }, 'Failed to register Swagger');
    }
  }

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

  const managedDb = resolveManagedAuthDb(options);
  if (managedDb) {
    app.addHook('onClose', async () => {
      await closeDatabase(managedDb);
    });
  }

  const serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
  const serviceVersion = options.serviceVersion ?? DEFAULT_SERVICE_VERSION;
  const startedAt = Date.now();

  const authDb = options.authDb ?? managedDb;
  const notificationDb = options.notificationDb ?? managedDb;
  const curriculumDb = options.curriculumDb;
  const marketingDb = options.marketingDb ?? managedDb;

  app.get('/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      service: serviceName,
      version: serviceVersion,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  });

  const authRouteOptions: Parameters<typeof registerAuthRoutes>[1] = {};
  if (options.auth) authRouteOptions.auth = options.auth;
  if (authDb) authRouteOptions.db = authDb;
  await registerAuthRoutes(app, authRouteOptions);
  
  // JWT Multi-Role Auth Routes
  if (authDb) {
    await registerJwtMultiRoleRoutes(app, { 
      db: authDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
      jwtExpiryDays: parseInt(process.env.JWT_EXPIRY_DAYS || '7', 10),
    });
  }
  
  await app.register(registerJobRoutes);

  // B2-05: Wire job status and recovery routes
  const quotaDb = options.quotaDb ?? managedDb;
  if (quotaDb) {
    const queueEnv = parseQueueEnv(process.env);
    const jobStore = new InMemoryQueueStore();
    const quotaRepo = new QuotaReservationRepository(quotaDb);
    const quotaLedger = new QuotaLedger(quotaRepo);
    const jobStatusAdapter = new QueueJobStatusAdapter(jobStore, {
      leaseTtlMs: queueEnv.leaseTtlMs,
      maxAttempts: queueEnv.maxAttempts,
    });
    const jobStatusService = new JobStatusService(jobStatusAdapter, quotaLedger);
    registerJobStatusRoutes(app, jobStatusService);
  }

  if (curriculumDb) {
    await registerCurriculumRoutes(app, { db: curriculumDb });
  }
  if (marketingDb) {
    await registerMarketingRoutes(app, { db: marketingDb });
    await registerMarketingOpsRoutes(app, { db: marketingDb });
  }
  await app.register(registerNotificationRoutes, notificationDb ? { db: notificationDb } : {});
  await registerUploadsAuthHook(app);
  await registerUploadRoutes(app, options.uploadsDb ? { db: options.uploadsDb } : {});

  return app;
}

function resolveManagedAuthDb(options: BuildAppOptions): Database | null {
  if (
    options.auth ||
    options.authDb ||
    options.notificationDb ||
    options.curriculumDb ||
    options.marketingDb ||
    options.uploadsDb
  )
    return null;
  try {
    const env = parseDatabaseEnv(process.env);
    if (!env.url) return null;
    return createDatabase({
      connectionString: env.url,
      poolMax: env.poolMax,
      ssl: env.sslMode === 'require',
    });
  } catch {
    return null;
  }
}
