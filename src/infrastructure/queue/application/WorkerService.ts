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
import { InMemorySourceExtractionJobsStore, InMemorySourcePassagesStore } from '../../../modules/sources/persistence/InMemorySourceExtractionStores.js';
import { SourceExtractionService, StubTextExtractorAdapter } from '../../../modules/sources/application/SourceExtractionService.js';
import { createStorageAdapter } from '../../storage/createStorageAdapter.js';

export interface WorkerServiceOptions {
  workerId: string;
  concurrency: number;
  pollIntervalMs: number;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  shutdownGracePeriodMs: number;
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
    };

    this.executor = new WorkerExecutor(store, this.registry, executorOptions);
  }

  private setupHandlers(): void {
    // SourceIngestionHandler requires storage + extraction service deps.
    // WorkerService wires stub/in-memory adapters here; production wiring
    // passes a real Database and storage via WorkerServiceOptions extensions (B2-02).
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
    this.registry.register(new AssessmentGenerationHandler());
    this.registry.register(new QuestionRegenerationHandler());
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
