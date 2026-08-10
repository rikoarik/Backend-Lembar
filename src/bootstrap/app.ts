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
import {
  closeDatabase,
  createDatabase,
  getPool,
  type Database,
} from '../infrastructure/database/db.js';
import { registerJobRoutes } from '../infrastructure/queue/adapters/http/jobRoutes.js';
import { createSharedQueueStore } from '../infrastructure/queue/createSharedQueueStore.js';
import { registerAuthRoutes } from '../modules/auth/adapters/http/routes.js';
import { registerJwtMultiRoleRoutes } from '../modules/auth/adapters/http/jwtMultiRoleRoutes.js';
import { registerPasswordResetRoutes } from '../modules/auth/adapters/http/passwordResetRoutes.js';
import { registerGoogleOAuthRoutes } from '../modules/auth/adapters/http/googleOAuthRoutes.js';
import { registerCurriculumRoutes } from '../modules/curriculum/adapters/http/routes.js';
import { registerMarketingRoutes } from '../modules/marketing/adapters/http/routes.js';
import { registerMarketingOpsRoutes } from '../modules/marketing/adapters/http/opsRoutes.js';
import { registerNotificationRoutes } from '../modules/notifications/adapters/http/routes.js';
import { registerUploadRoutes } from '../modules/uploads/adapters/http/routes.js';
import { registerUploadsAuthHook } from '../modules/uploads/adapters/http/preHandler.js';
import type { AuthService } from '../modules/auth/application/AuthService.js';

// B6-04: Ops routes
import { MetricsCollector } from '../modules/ops/application/MetricsCollector.js';
import {
  LeadCaptureService,
  InMemoryLeadStore,
} from '../modules/ops/application/LeadCaptureService.js';
import { registerOpsRoutes } from '../modules/ops/adapters/http/opsRoutes.js';

// B6-01: Plan routes
import { PlanService } from '../modules/plans/application/PlanService.js';
import { WorkspacePlanRepository } from '../modules/plans/persistence/repository.js';
import { TrialRepository } from '../modules/plans/persistence/trialRepository.js';
import { TrialService } from '../modules/plans/application/TrialService.js';
import { registerPlanRoutes } from '../modules/plans/adapters/http/planRoutes.js';

// B6-02: Payment integration
import { PaymentRepository } from '../modules/payment/persistence/repository.js';
import { PaymentService } from '../modules/payment/application/PaymentService.js';
import { registerWebhookRoutes } from '../modules/payment/adapters/http/webhookRoutes.js';
import { registerSubscriptionRoutes } from '../modules/payment/adapters/http/subscriptionRoutes.js';

// B2-03: Assessment routes + full core product flow
import { AssessmentService } from '../modules/assessments/application/AssessmentService.js';
import { InMemoryAssessmentsStore } from '../modules/assessments/persistence/InMemoryAssessmentsStore.js';
import { PostgresAssessmentsStore } from '../modules/assessments/persistence/PostgresAssessmentsStore.js';
import { registerAssessmentRoutes } from '../modules/assessments/adapters/http/routes.js';
import { InMemorySourceUploadsStore } from '../modules/uploads/persistence/InMemorySourceUploadsStore.js';
import { InMemorySourceExtractionJobsStore } from '../modules/sources/persistence/InMemorySourceExtractionStores.js';
// B5-04: History + bank soal
import { HistoryService } from '../modules/assessments/application/HistoryService.js';
import { InMemoryQuestionGenerationStore } from '../modules/assessments/persistence/InMemoryQuestionGenerationStore.js';
import { PostgresQuestionGenerationStore } from '../modules/assessments/persistence/PostgresQuestionGenerationStore.js';
import { registerHistoryRoutes } from '../modules/assessments/adapters/http/historyRoutes.js';
// B5-03: Share links
import { ShareLinkService } from '../modules/assessments/application/ShareLinkService.js';
import { PostgresShareLinkStore } from '../modules/assessments/persistence/PostgresShareLinkStore.js';
import { InMemoryShareLinkStore } from '../modules/assessments/persistence/InMemoryShareLinkStore.js';
import { registerShareRoutes } from '../modules/assessments/adapters/http/shareRoutes.js';
import { DurableAttemptService } from '../modules/lms/application/DurableAttemptService.js';
import { PostgresAttemptStore } from '../modules/lms/persistence/PostgresAttemptStore.js';
import { registerDurableAttemptRoutes } from '../modules/lms/adapters/http/durableAttemptRoutes.js';
// B4-01: Question review + finalization
import { QuestionReviewService } from '../modules/assessments/application/QuestionReviewService.js';
import { InMemoryQuestionReviewStore } from '../modules/assessments/persistence/InMemoryQuestionReviewStore.js';
import { PostgresQuestionReviewStore } from '../modules/assessments/persistence/PostgresQuestionReviewStore.js';
import { FinalizationService } from '../modules/assessments/application/FinalizationService.js';
import { registerQuestionReviewRoutes } from '../modules/assessments/adapters/http/questionReviewRoutes.js';
// B3-02: Blueprint pipeline
import { BlueprintPipelineService } from '../modules/assessments/application/BlueprintPipelineService.js';
import { InMemoryBlueprintPipelineStore } from '../modules/assessments/persistence/InMemoryBlueprintPipelineStore.js';
import { registerBlueprintPipelineRoutes } from '../modules/assessments/adapters/http/blueprintRoutes.js';
import { SourceRetrievalService } from '../modules/sources/application/SourceRetrievalService.js';
import { InMemorySourceRetrievalStore } from '../modules/sources/persistence/InMemorySourceRetrievalStore.js';
import { InMemorySourcePassagesStore } from '../modules/sources/persistence/InMemorySourceExtractionStores.js';
// B5-01/B5-02: Print + artifact
import { PrintService } from '../modules/assessments/application/PrintService.js';
import { PrintArtifactService } from '../modules/assessments/application/PrintArtifactService.js';
import { InMemoryPrintArtifactStore } from '../modules/assessments/persistence/InMemoryPrintArtifactStore.js';
import { registerPrintRoutes } from '../modules/assessments/adapters/http/printRoutes.js';
import { registerArtifactRoutes } from '../modules/assessments/adapters/http/artifactRoutes.js';
import { InMemoryAdapter } from '../infrastructure/storage/InMemoryAdapter.js';

// B2-05: Job status and recovery routes
import { QueueJobStatusAdapter } from '../modules/jobs/adapters/QueueJobStatusAdapter.js';
import { JobStatusService } from '../modules/jobs/application/JobStatusService.js';
import { registerJobStatusRoutes } from '../modules/jobs/adapters/http/routes.js';
import { QuotaLedger } from '../modules/quota/application/QuotaLedger.js';
import { QuotaReservationRepository } from '../modules/quota/persistence/repository.js';

// Catalog routes
import { registerCatalogRoutes } from '../modules/catalog/adapters/http/catalogRoutes.js';

// Admin routes
import { AdminService } from '../modules/admin/application/AdminService.js';
import { PostgresAdminDataStore } from '../modules/admin/persistence/PostgresAdminDataStore.js';
import { NoOpAdminAuditStore } from '../modules/admin/persistence/NoOpAdminAuditStore.js';
import { registerAdminRoutes } from '../modules/admin/adapters/http/adminRoutes.js';
import { registerAiPromptRoutes } from '../modules/admin/adapters/http/aiPromptRoutes.js';
import { registerAiProviderRoutes } from '../modules/admin/adapters/http/aiProviderRoutes.js';
import { registerAiFeedbackRoutes } from '../modules/ai/adapters/http/aiFeedbackRoutes.js';

// School routes
import { SchoolService } from '../modules/school/application/SchoolService.js';
import { SchoolDashboardService } from '../modules/school/application/SchoolDashboardService.js';
import {
  InMemorySchoolWorkspaceStore,
  InMemorySchoolInvitationStore,
} from '../modules/school/persistence/InMemorySchoolStores.js';
import { PostgresSchoolWorkspaceStore } from '../modules/school/persistence/PostgresSchoolStores.js';
import { PostgresSchoolInvitationStore } from '../modules/school/persistence/PostgresSchoolStores.js';
import { registerSchoolRoutes } from '../modules/school/adapters/http/schoolRoutes.js';
import { registerDashboardRoutes } from '../modules/school/adapters/http/dashboardRoutes.js';
import { registerMemberRoutes } from '../modules/school/adapters/http/memberRoutes.js';
import { registerStatsRoutes } from '../modules/school/adapters/http/statsRoutes.js';
import { registerLibraryRoutes } from '../modules/school/adapters/http/libraryRoutes.js';
import { registerSchoolAuditRoutes } from '../modules/school/adapters/http/schoolAuditRoutes.js';
import { registerSettingsRoutes } from '../modules/school/adapters/http/settingsRoutes.js';
import { registerUsageRoutes } from '../modules/school/adapters/http/usageRoutes.js';
import { registerSuspendRoutes } from '../modules/school/adapters/http/suspendRoutes.js';
import { registerSchoolNotificationsRoutes } from '../modules/school/adapters/http/schoolNotificationsRoutes.js';
import { registerBillingRoutes } from '../modules/school/adapters/http/billingRoutes.js';
import { SchoolBillingService } from '../modules/school/application/SchoolBillingService.js';
import { registerClassRoutes } from '../modules/classes/adapters/http/classRoutes.js';
import { registerTemplateRoutes } from '../modules/templates/adapters/http/templateRoutes.js';
import { registerPublicSupportRoutes } from '../modules/support/publicSupport.js';

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
    trustProxy: '127.0.0.1',
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
    const url = req.url;
    const method = req.method;

    // Helpful message for known-but-unregistered routes
    const hints: Record<string, string> = {
      '/v1/admin': 'Module admin belum di-register. Butuh AdminDataStore implementation.',
      '/v1/catalog':
        'Module catalog belum di-register. Endpoint ada di OpenAPI spec tapi belum ada backend implementation.',
    };

    const hintKey = Object.keys(hints).find((k) => url.startsWith(k));
    const message = hintKey
      ? `${hints[hintKey]} (${method} ${url})`
      : `Endpoint tidak ditemukan: ${method} ${url}. Cek /docs untuk daftar endpoint yang tersedia.`;

    const { status, payload } = envelopeFor(404, 'RESOURCE_NOT_FOUND', message, id);
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
  const curriculumDb = options.curriculumDb ?? managedDb;
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

  await registerPublicSupportRoutes(app);

  // Session-based auth disabled — using JWT auth only
  // const authRouteOptions: Parameters<typeof registerAuthRoutes>[1] = {};
  // if (options.auth) authRouteOptions.auth = options.auth;
  // if (authDb) authRouteOptions.db = authDb;
  // await registerAuthRoutes(app, authRouteOptions);

  // JWT Multi-Role Auth Routes (primary auth)
  if (authDb) {
    await registerJwtMultiRoleRoutes(app, {
      db: authDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
      jwtExpiryDays: parseInt(process.env.JWT_EXPIRY_DAYS || '7', 10),
    });
    await registerPasswordResetRoutes(app, { db: authDb });

    // Google OAuth routes
    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const googleRedirectUri =
      process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3000/auth/callback';

    if (googleClientId && googleClientSecret) {
      await registerGoogleOAuthRoutes(app, {
        db: authDb,
        config: {
          clientId: googleClientId,
          clientSecret: googleClientSecret,
          redirectUri: googleRedirectUri,
          jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
          jwtExpiryDays: parseInt(process.env.JWT_EXPIRY_DAYS ?? '7', 10),
        },
      });
    }
  }

  const generationPlanRepo = managedDb ? new WorkspacePlanRepository(managedDb) : null;
  const generationTrialRepo = managedDb ? new TrialRepository(managedDb) : null;
  const generationPlanService =
    generationPlanRepo && generationTrialRepo
      ? new PlanService(generationPlanRepo, generationTrialRepo)
      : null;
  await app.register(registerJobRoutes, {
    Store: createSharedQueueStore(process.env),
    jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
    ...(generationPlanService
      ? {
          generationAccess: {
            assertGenerationAllowed: async (input) =>
              generationPlanService.assertQuota(
                input.tenantId,
                input.workspaceId,
                input.deviceToken,
              ),
            recordGeneration: async (input) =>
              generationPlanService.recordGeneration(
                input.tenantId,
                input.workspaceId,
                input.idempotencyKey,
              ),
          },
        }
      : {}),
  });

  // B2-05: Wire job status and recovery routes
  const quotaDb = options.quotaDb ?? managedDb;
  if (quotaDb) {
    const queueEnv = parseQueueEnv(process.env);
    const jobStore = createSharedQueueStore(process.env);
    const quotaRepo = new QuotaReservationRepository(quotaDb);
    const quotaLedger = new QuotaLedger(quotaRepo);
    const jobStatusAdapter = new QueueJobStatusAdapter(jobStore, {
      leaseTtlMs: queueEnv.leaseTtlMs,
      maxAttempts: queueEnv.maxAttempts,
    });
    const jobStatusService = new JobStatusService(jobStatusAdapter, quotaLedger);
    registerJobStatusRoutes(app, jobStatusService, {
      jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
    });
  }

  if (curriculumDb) {
    await registerCurriculumRoutes(app, { db: curriculumDb });
  }
  if (marketingDb) {
    await registerMarketingRoutes(app, { db: marketingDb });
    await registerMarketingOpsRoutes(app, { db: marketingDb });
  }
  await app.register(registerNotificationRoutes, notificationDb ? { db: notificationDb } : {});
  await registerUploadsAuthHook(app, {
    jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
  });
  await registerUploadRoutes(app, options.uploadsDb ? { db: options.uploadsDb } : {});

  // B6-04: Ops routes (metrics + leads)
  if (managedDb) {
    const metrics = new MetricsCollector();
    const leadStore = new InMemoryLeadStore();
    const leads = new LeadCaptureService(leadStore);
    registerOpsRoutes(app, { metrics, leads });
  }

  // B6-01: Plan routes
  if (managedDb) {
    const planRepo = new WorkspacePlanRepository(managedDb);
    const trialRepo = new TrialRepository(managedDb);
    const planService = new PlanService(planRepo, trialRepo);
    registerPlanRoutes(app, planService, {
      trials: new TrialService(
        trialRepo,
        process.env.TRIAL_IDENTITY_PEPPER ??
          process.env.JWT_SECRET ??
          'dev-secret-change-in-production',
      ),
      jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
    });
  }

  // B6-02: Payment integration routes (webhook + subscription upgrade/downgrade)
  if (managedDb) {
    const planRepo = new WorkspacePlanRepository(managedDb);
    const paymentRepo = new PaymentRepository(managedDb);
    const paymentOpts: {
      midtransServerKey?: string | undefined;
      stripeWebhookSecret?: string | undefined;
      pakasirApiKey?: string | undefined;
      pakasirProjectSlug?: string | undefined;
    } = {};
    const midtransKey = process.env['MIDTRANS_SERVER_KEY'];
    const stripeSecret = process.env['STRIPE_WEBHOOK_SECRET'];
    const pakasirKey = process.env['PAKASIR_API_KEY'];
    const pakasirSlug = process.env['PAKASIR_PROJECT_SLUG'];
    if (midtransKey !== undefined) paymentOpts.midtransServerKey = midtransKey;
    if (stripeSecret !== undefined) paymentOpts.stripeWebhookSecret = stripeSecret;
    if (pakasirKey !== undefined) paymentOpts.pakasirApiKey = pakasirKey;
    if (pakasirSlug !== undefined) paymentOpts.pakasirProjectSlug = pakasirSlug;
    const paymentService = new PaymentService(paymentRepo, planRepo, paymentOpts);
    const paymentRouteOptions = {
      paymentService,
      db: managedDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    };
    await registerWebhookRoutes(app, paymentRouteOptions);
    await registerSubscriptionRoutes(app, paymentRouteOptions);
  }

  // B2-03: Assessment routes (Postgres when configured; in-memory for local smoke)
  {
    const pool = managedDb ? getPool(managedDb) : undefined;
    const assessmentStore = managedDb
      ? new PostgresAssessmentsStore(managedDb)
      : new InMemoryAssessmentsStore();
    const uploadsStore = new InMemorySourceUploadsStore();
    const extractionJobsStore = new InMemorySourceExtractionJobsStore();
    const questionGenStore = pool
      ? new PostgresQuestionGenerationStore(pool)
      : new InMemoryQuestionGenerationStore();
    const questionReviewStore = managedDb
      ? new PostgresQuestionReviewStore(managedDb)
      : new InMemoryQuestionReviewStore();
    const blueprintStore = new InMemoryBlueprintPipelineStore();
    const shareLinkStore = managedDb
      ? new PostgresShareLinkStore(managedDb)
      : new InMemoryShareLinkStore();
    const printArtifactStore = new InMemoryPrintArtifactStore();

    const assessmentService = new AssessmentService({
      store: assessmentStore,
      uploadsStore,
      extractionJobsStore,
    });

    // B5-04: History + bank soal
    const historyService = new HistoryService({
      assessmentsStore: assessmentStore,
      questionStore: questionGenStore,
    });

    // B5-03: Share links
    const shareLinkService = new ShareLinkService({ store: shareLinkStore });

    // B4-01: Question review + finalization
    const questionReviewService = new QuestionReviewService({ store: questionReviewStore });
    const finalizationService = new FinalizationService({
      store: questionReviewStore,
      reviewService: questionReviewService,
    });

    // B3-02: Blueprint pipeline
    const passagesStore = new InMemorySourcePassagesStore();
    const sourceRetrievalStore = new InMemorySourceRetrievalStore({ passagesStore, uploadsStore });
    const sourceRetrievalService = new SourceRetrievalService({
      retrievalStore: sourceRetrievalStore,
    });
    const blueprintService = new BlueprintPipelineService({
      store: blueprintStore,
      assessmentsStore: assessmentStore,
      retrievalService: sourceRetrievalService,
    });

    // B5-01/B5-02: Print + artifact
    const printService = new PrintService({
      assessmentsStore: assessmentStore,
      reviewStore: questionReviewStore,
    });
    const { InMemoryAdapter } = await import('../infrastructure/storage/InMemoryAdapter.js');
    const storageAdapter = new InMemoryAdapter();
    const printArtifactService = new PrintArtifactService({
      artifactStore: printArtifactStore,
      storage: storageAdapter,
      printService,
    });

    // Register all routes
    const assessmentAuth = {
      jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
    };
    registerAssessmentRoutes(app, assessmentService, assessmentAuth);
    await registerHistoryRoutes(app, historyService);
    await registerShareRoutes(app, shareLinkService, {
      assessmentsStore: assessmentStore,
      questionStore: questionGenStore,
      ...assessmentAuth,
    });
    if (managedDb) {
      const pool = getPool(managedDb);
      if (pool)
        await registerDurableAttemptRoutes(app, {
          service: new DurableAttemptService(new PostgresAttemptStore(pool)),
          shareService: shareLinkService,
          assessmentsStore: assessmentStore,
          questionStore: questionGenStore,
          ...assessmentAuth,
        });
    }
    await registerQuestionReviewRoutes(
      app,
      questionReviewService,
      finalizationService,
      assessmentAuth,
    );
    await registerBlueprintPipelineRoutes(app, blueprintService);
    await registerPrintRoutes(app, printService, assessmentAuth);
    await registerArtifactRoutes(app, printArtifactService, assessmentAuth);
  }

  // Catalog routes (fallback to static data if DB empty)
  await registerCatalogRoutes(app, {
    db: curriculumDb ?? undefined,
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  });

  // Admin routes (JWT superadmin auth)
  if (managedDb) {
    const adminStore = new PostgresAdminDataStore(managedDb);
    const auditStore = new NoOpAdminAuditStore();
    const adminService = new AdminService(adminStore, auditStore);
    registerAdminRoutes(app, {
      service: adminService,
      db: managedDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    });
    // AI Prompt Management routes
    registerAiPromptRoutes(app, {
      db: managedDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    });
    // AI Provider config routes — superadmin only
    registerAiProviderRoutes(app, {
      db: managedDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    });
    // AI Feedback routes — subscriber-facing, populates the same ai_feedback table
    registerAiFeedbackRoutes(app, {
      db: managedDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    });
  }

  // School routes (Postgres-backed stores)
  if (managedDb) {
    const schoolWorkspaceStore = new PostgresSchoolWorkspaceStore(managedDb);
    const schoolInvitationStore = new PostgresSchoolInvitationStore(managedDb);
    const schoolService = new SchoolService(schoolWorkspaceStore, schoolInvitationStore);
    registerSchoolRoutes(app, {
      service: schoolService,
      db: managedDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    });

    // School dashboard
    const schoolDashboardService = new SchoolDashboardService(
      schoolWorkspaceStore,
      new WorkspacePlanRepository(managedDb),
    );
    registerDashboardRoutes(app, {
      dashboardService: schoolDashboardService,
      db: managedDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    });

    // School member management (list, invite, update role, remove)
    registerMemberRoutes(app, {
      service: schoolService,
      db: managedDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    });

    // School stats (KPI aggregates for admin panel)
    registerStatsRoutes(app, {
      workspaceStore: schoolWorkspaceStore,
      planRepo: new WorkspacePlanRepository(managedDb),
      db: managedDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    });

    // School library (finalized assessments visible to workspace members)
    registerLibraryRoutes(app, {
      db: managedDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    });

    // School audit log + invitations management (school_admin only)
    registerSchoolAuditRoutes(app, {
      db: managedDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    });

    // School settings (GET profile, PATCH name — school_admin | teacher)
    registerSettingsRoutes(app, {
      db: managedDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    });

    // School usage (quota used/limit, per-user breakdown, monthly trend)
    registerUsageRoutes(app, {
      db: managedDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    });

    // School member suspend / unsuspend (school_admin only)
    registerSuspendRoutes(app, {
      db: managedDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    });

    // School notifications (recent outbox entries for school_admin)
    registerSchoolNotificationsRoutes(app, {
      db: managedDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    });

    // School billing snapshot (seat count, plan tier, usage — school_admin only)
    const schoolBillingService = new SchoolBillingService(
      schoolWorkspaceStore,
      new WorkspacePlanRepository(managedDb),
    );
    registerBillingRoutes(app, {
      billingService: schoolBillingService,
      db: managedDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    });

    await registerClassRoutes(app, {
      db: managedDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    });
    await registerTemplateRoutes(app, {
      db: managedDb,
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    });

    // Note: Demo workspaces are now in the database. No in-memory seeding needed.
  }

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
