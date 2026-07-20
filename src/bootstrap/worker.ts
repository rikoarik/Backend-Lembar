import { createHash } from 'node:crypto';

import { type WorkerEnv, parseWorkerEnv } from '../config/worker.env.js';
import { createWorkerService } from '../infrastructure/queue/index.js';
import { InMemoryQueueStore } from '../infrastructure/queue/adapters/memory-store.js';

// B2-05: Quota lifecycle hooks
import { QueueJobStatusAdapter } from '../modules/jobs/adapters/QueueJobStatusAdapter.js';
import { JobStatusService } from '../modules/jobs/application/JobStatusService.js';
import { QuotaLedger } from '../modules/quota/application/QuotaLedger.js';
import { QuotaReservationRepository } from '../modules/quota/persistence/repository.js';
import { parseDatabaseEnv } from '../config/database.env.js';
import { createDatabase } from '../infrastructure/database/db.js';
import { parseQueueEnv } from '../config/queue.env.js';

export interface Heartbeat {
  event: 'worker.heartbeat';
  service: string;
  name: string;
  version: string;
  concurrency: number;
  emittedAt: string;
  // Deterministic id derived only from name+version+tick — no secrets, no PII.
  id: string;
}

export interface WorkerRuntimeOptions {
  name: string;
  version: string;
  tick: number;
  concurrency: number;
}

export function resolveWorkerOptions(env: NodeJS.ProcessEnv = process.env): WorkerRuntimeOptions {
  const cfg: WorkerEnv = parseWorkerEnv(env);
  return {
    name: cfg.workerName,
    version: cfg.serviceVersion,
    tick: 1,
    concurrency: cfg.workerConcurrency,
  };
}

export function buildHeartbeat(options: WorkerRuntimeOptions, now: Date = new Date()): Heartbeat {
  const id = createHash('sha256')
    .update(`${options.name}|${options.version}|${options.tick}`)
    .digest('hex')
    .slice(0, 16);
  return {
    event: 'worker.heartbeat',
    service: options.name,
    name: options.name,
    version: options.version,
    concurrency: options.concurrency,
    emittedAt: now.toISOString(),
    id,
  };
}

// Boot when run directly.
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('bootstrap/worker.js') === true;

if (isDirectRun) {
  const options = resolveWorkerOptions();
  const heartbeat = buildHeartbeat(options);
  process.stdout.write(`${JSON.stringify(heartbeat)}\n`);

  // Start worker service
  // TODO: Replace InMemoryQueueStore with PostgresQueueStore in production
  const store = new InMemoryQueueStore();

  // B2-05: Set up quota lifecycle hooks
  let quotaLedger: QuotaLedger | null = null;
  try {
    const dbEnv = parseDatabaseEnv(process.env);
    if (dbEnv.url) {
      const db = createDatabase({
        connectionString: dbEnv.url,
        poolMax: dbEnv.poolMax,
        ssl: dbEnv.sslMode === 'require',
      });
      const quotaRepo = new QuotaReservationRepository(db);
      quotaLedger = new QuotaLedger(quotaRepo);
    }
  } catch {
    // No database configured; quota lifecycle hooks disabled
  }

  const queueEnv = parseQueueEnv(process.env);
  const jobStatusAdapter = new QueueJobStatusAdapter(store, {
    leaseTtlMs: queueEnv.leaseTtlMs,
    maxAttempts: queueEnv.maxAttempts,
  });
  const jobStatusService = quotaLedger
    ? new JobStatusService(jobStatusAdapter, quotaLedger)
    : null;

  const worker = createWorkerService(store, {
    workerId: heartbeat.id,
    concurrency: options.concurrency,
    pollIntervalMs: 1000,
    leaseTtlMs: 30_000,
    heartbeatIntervalMs: 10_000,
    shutdownGracePeriodMs: 30_000,
    onJobComplete: jobStatusService
      ? async (jobId, workspaceId, outcome) => {
          try {
            if (outcome === 'success') {
              await jobStatusService.commitOnSuccess(jobId, workspaceId);
            } else {
              await jobStatusService.releaseOnFailure(jobId, workspaceId);
            }
          } catch (err) {
            console.error(`[Worker] Quota lifecycle hook failed for job ${jobId}:`, err);
          }
        }
      : undefined,
  });

  // Graceful shutdown handlers
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n[Worker] Received ${signal}, shutting down gracefully...`);
    try {
      await worker.shutdown();
      console.log('[Worker] Shutdown complete');
      process.exit(0);
    } catch (err) {
      console.error('[Worker] Shutdown failed:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start worker
  worker
    .start()
    .then(() => {
      console.log('[Worker] Worker service started successfully');
      console.log(`[Worker] Health: ${JSON.stringify(worker.health())}`);
    })
    .catch((err) => {
      console.error('[Worker] Failed to start worker:', err);
      process.exit(1);
    });
}
