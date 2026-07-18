import { createHash } from 'node:crypto';

import { type WorkerEnv, parseWorkerEnv } from '../config/worker.env.js';

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
  const heartbeat = buildHeartbeat(resolveWorkerOptions());
  process.stdout.write(`${JSON.stringify(heartbeat)}\n`);
  process.exit(0);
}
