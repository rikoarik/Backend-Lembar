/**
 * Worker service orchestrator — main entry point for background job processing.
 *
 * Combines queue store, handler registry, and worker executor into a complete
 * worker service with health checks and graceful shutdown.
 */
import type { QueueStore } from '../adapters/queue-store.js';
import { DefaultJobHandlerRegistry } from '../domain/JobHandler.js';
import { WorkerExecutor, type WorkerExecutorOptions } from './WorkerExecutor.js';
import {
  SourceIngestionHandler,
  AssessmentGenerationHandler,
  QuestionRegenerationHandler,
  ExportPdfHandler,
} from '../handlers/index.js';
import { InMemorySourceUploadsStore } from '../../../modules/uploads/persistence/InMemorySourceUploadsStore.js';
import {
  InMemorySourceExtractionJobsStore,
  InMemorySourcePassagesStore,
} from '../../../modules/sources/persistence/InMemorySourceExtractionStores.js';
import {
  SourceExtractionService,
  StubTextExtractorAdapter,
} from '../../../modules/sources/application/SourceExtractionService.js';
import { createStorageAdapter } from '../../storage/createStorageAdapter.js';
// AI generate deps
import { QuestionGenerationService } from '../../../modules/assessments/application/QuestionGenerationService.js';
import { InMemoryQuestionGenerationStore } from '../../../modules/assessments/persistence/InMemoryQuestionGenerationStore.js';
import { PostgresQuestionGenerationStore } from '../../../modules/assessments/persistence/PostgresQuestionGenerationStore.js';
import { QuestionReviewService } from '../../../modules/assessments/application/QuestionReviewService.js';
import { InMemoryQuestionReviewStore } from '../../../modules/assessments/persistence/InMemoryQuestionReviewStore.js';
import { PostgresQuestionReviewStore } from '../../../modules/assessments/persistence/PostgresQuestionReviewStore.js';
import { BlueprintPipelineService } from '../../../modules/assessments/application/BlueprintPipelineService.js';
import { InMemoryBlueprintPipelineStore } from '../../../modules/assessments/persistence/InMemoryBlueprintPipelineStore.js';
import { InMemoryAssessmentsStore } from '../../../modules/assessments/persistence/InMemoryAssessmentsStore.js';
import { PostgresAssessmentsStore } from '../../../modules/assessments/persistence/PostgresAssessmentsStore.js';
import { InMemorySourceRetrievalStore } from '../../../modules/sources/persistence/InMemorySourceRetrievalStore.js';
import { SourceRetrievalService } from '../../../modules/sources/application/SourceRetrievalService.js';
import { ProductAiService } from '../../ai/application/ProductAiService.js';
import {
  AiAuditRepository,
  InMemoryAiAuditRecorder,
} from '../../ai/persistence/AiAuditRepository.js';
import { parseAiEnv } from '../../../config/ai.env.js';
import { MockAiAdapter } from '../../ai/adapters/mock/MockAiAdapter.js';
import { HermesAdapter } from '../../ai/adapters/hermes/HermesAdapter.js';
import { closeDatabase, createDatabase, getPool, type Database } from '../../database/db.js';
import { QUESTION_OUTPUT_SCHEMA } from '../../../modules/assessments/application/QuestionGenerationService.js';
import { WorkspacePlanRepository } from '../../../modules/plans/persistence/repository.js';

export interface WorkerServiceOptions {
  workerId: string;
  concurrency: number;
  pollIntervalMs: number;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  shutdownGracePeriodMs: number;
  onJobComplete?:
    | ((jobId: string, workspaceId: string, outcome: 'success' | 'failure') => void | Promise<void>)
    | undefined;
  /** Optional: inject a custom AI adapter (HermesAdapter etc). If omitted, uses mock. */
  aiAdapter?: import('../../ai/domain/ProductAiAdapter.js').ProductAiAdapter;
}

export interface WorkerServiceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  workerId: string;
  uptime: number;
  activeJobs: number;
  registeredHandlers: string[];
  lastPollAt: string | null;
  errors: string[];
}

export class WorkerService {
  private readonly store: QueueStore;
  private readonly registry: DefaultJobHandlerRegistry;
  private readonly executor: WorkerExecutor;
  private readonly options: WorkerServiceOptions;
  private readonly startTime: Date;
  private lastPollAt: Date | null = null;
  private errors: string[] = [];
  private managedDb: Database | null = null;

  constructor(store: QueueStore, options: WorkerServiceOptions) {
    this.store = store;
    this.options = options;
    this.startTime = new Date();
    this.registry = new DefaultJobHandlerRegistry();
    this.setupHandlers();

    const executorOptions: WorkerExecutorOptions = {
      workerId: options.workerId,
      concurrency: options.concurrency,
      pollIntervalMs: options.pollIntervalMs,
      leaseTtlMs: options.leaseTtlMs,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      shutdownGracePeriodMs: options.shutdownGracePeriodMs,
      onJobComplete: options.onJobComplete,
    };

    this.executor = new WorkerExecutor(store, this.registry, executorOptions);
  }

  private setupHandlers(): void {
    // SourceIngestionHandler requires storage + extraction service deps.
    const storage = createStorageAdapter();
    const jobsStore = new InMemorySourceExtractionJobsStore();
    const passagesStore = new InMemorySourcePassagesStore();
    const extractionService = new SourceExtractionService({
      jobsStore,
      passagesStore,
      extractor: new StubTextExtractorAdapter(),
    });
    this.registry.register(
      new SourceIngestionHandler({
        uploadsStore: new InMemorySourceUploadsStore(),
        storage,
        extractionService,
      }),
    );

    // AI generate: wire QuestionGenerationService with AI adapter
    let aiEnv;
    try {
      aiEnv = parseAiEnv(process.env);
    } catch {
      // fallback to mock if env is misconfigured
      aiEnv = parseAiEnv({ AI_DRIVER: 'mock' } as any);
    }

    const aiAdapter = this.options.aiAdapter ?? buildAiAdapterFromEnv(aiEnv);

    // Register JSON schemas for every prompt template id the worker may dispatch.
    // ponytail: schema registry stays in-memory here. Add a Postgres-backed schema
    // store once the prompt registry leaves spike_jobs and becomes a real entity.
    const schemas = new Map<string, Record<string, unknown>>([
      ['question-generation-v1', QUESTION_OUTPUT_SCHEMA],
    ]);

    // Audit recorder: prefer Postgres when DATABASE_URL is set, else fall back to
    // in-memory so local smoke / tests stay green without a database.
    const databaseUrl = process.env.DATABASE_URL;
    let audit: AiAuditRepository | InMemoryAiAuditRecorder;
    if (databaseUrl && databaseUrl.length > 0) {
      this.managedDb = createDatabase({ connectionString: databaseUrl });
      audit = new AiAuditRepository(this.managedDb);
    } else {
      audit = new InMemoryAiAuditRecorder();
    }

    const aiService = new ProductAiService({
      adapter: aiAdapter,
      env: aiEnv,
      schemas,
      audit,
      ...(this.managedDb
        ? {
            tokenUsage: {
              recordTokenUsage: (
                workspaceId: string,
                providerCallId: string,
                tokens: number,
                source: 'actual' | 'estimated',
              ) =>
                new WorkspacePlanRepository(this.managedDb!).recordTokenUsage(
                  workspaceId,
                  workspaceId,
                  providerCallId,
                  tokens,
                  source,
                ),
            },
          }
        : {}),
    });

    const uploadsStore = new InMemorySourceUploadsStore();
    const retrievalStore = new InMemorySourceRetrievalStore({ passagesStore, uploadsStore });
    const sourceRetrievalService = new SourceRetrievalService({ retrievalStore: retrievalStore });
    const assessmentsStore = this.managedDb
      ? new PostgresAssessmentsStore(this.managedDb)
      : new InMemoryAssessmentsStore();
    const blueprintStore = new InMemoryBlueprintPipelineStore();
    const blueprintService = new BlueprintPipelineService({
      store: blueprintStore,
      assessmentsStore,
      retrievalService: sourceRetrievalService,
    });

    const pool = this.managedDb ? getPool(this.managedDb) : undefined;
    const questionGenStore = pool
      ? new PostgresQuestionGenerationStore(pool)
      : new InMemoryQuestionGenerationStore();
    const questionReviewStore = this.managedDb
      ? new PostgresQuestionReviewStore(this.managedDb)
      : new InMemoryQuestionReviewStore();
    const questionReviewService = new QuestionReviewService({ store: questionReviewStore });
    const questionGenerationService = new QuestionGenerationService({
      store: questionGenStore,
      blueprintService,
      aiService,
      env: aiEnv,
    });

    this.registry.register(
      new AssessmentGenerationHandler({ questionGenerationService, questionReviewService, assessmentsStore }),
    );
    this.registry.register(new QuestionRegenerationHandler({ questionGenerationService }));
    this.registry.register(new ExportPdfHandler());
  }

  async start(): Promise<void> {
    console.log(`[WorkerService] Starting worker ${this.options.workerId}`);
    console.log(`[WorkerService] Concurrency: ${this.options.concurrency}`);
    console.log(`[WorkerService] Registered handlers: ${this.registry.list().join(', ')}`);

    try {
      await this.executor.start();
      this.lastPollAt = new Date();
      console.log(`[WorkerService] Worker started successfully`);
    } catch (err) {
      const error = `Failed to start worker: ${err instanceof Error ? err.message : String(err)}`;
      this.errors.push(error);
      console.error(`[WorkerService] ${error}`);
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    console.log(`[WorkerService] Shutting down worker ${this.options.workerId}`);
    try {
      await this.executor.shutdown();
      if (this.managedDb) await closeDatabase(this.managedDb);
      console.log(`[WorkerService] Worker shut down successfully`);
    } catch (err) {
      const error = `Failed to shutdown cleanly: ${err instanceof Error ? err.message : String(err)}`;
      this.errors.push(error);
      console.error(`[WorkerService] ${error}`);
      throw err;
    }
  }

  health(): WorkerServiceHealth {
    const now = Date.now();
    const uptime = now - this.startTime.getTime();
    const activeJobs = this.executor.getActiveJobCount();
    const isRunning = this.executor.isRunning();

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

    if (!isRunning) {
      status = 'unhealthy';
    } else if (this.errors.length > 0) {
      status = 'degraded';
    } else if (activeJobs >= this.options.concurrency) {
      status = 'degraded';
    }

    return {
      status,
      workerId: this.options.workerId,
      uptime,
      activeJobs,
      registeredHandlers: this.registry.list(),
      lastPollAt: this.lastPollAt?.toISOString() ?? null,
      errors: this.errors.slice(-10), // Last 10 errors
    };
  }

  isHealthy(): boolean {
    return this.health().status === 'healthy';
  }

  clearErrors(): void {
    this.errors = [];
  }
}

export function createWorkerService(
  store: QueueStore,
  options: Partial<WorkerServiceOptions> = {},
): WorkerService {
  const defaults: WorkerServiceOptions = {
    workerId: `worker-${Math.random().toString(36).slice(2, 9)}`,
    concurrency: 4,
    pollIntervalMs: 1000,
    leaseTtlMs: 30_000,
    heartbeatIntervalMs: 10_000,
    shutdownGracePeriodMs: 30_000,
  };

  return new WorkerService(store, { ...defaults, ...options });
}

/**
 * Build the AI adapter from the parsed env. Mirrors parseAiEnv's driver contract:
 *   - 'hermes' → HermesAdapter (live calls to configured provider + fallback chain)
 *   - everything else → MockAiAdapter (safe default, no provider spend)
 *
 * Kept as a free function so it stays trivially unit-testable and so the
 * `new MockAiAdapter()` path remains the single-line fallback for dev/CI.
 */
export function buildAiAdapterFromEnv(env: ReturnType<typeof parseAiEnv>) {
  if (env.driver === 'hermes' && env.hermesApiKey) {
    return new HermesAdapter({
      primary: {
        apiKey: env.hermesApiKey,
        baseUrl: env.hermesBaseUrl,
        modelId: env.modelId,
        timeoutMs: env.timeoutMs,
      },
      fallbacks: env.openaiApiKey
        ? [
            {
              apiKey: env.openaiApiKey,
              baseUrl: env.openaiBaseUrl,
              modelId: env.openaiModelId,
              timeoutMs: env.timeoutMs,
            },
          ]
        : [],
      live: true,
    });
  }
  return new MockAiAdapter();
}
