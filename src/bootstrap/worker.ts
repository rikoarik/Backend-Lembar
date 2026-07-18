import { createHash } from 'node:crypto';

export interface Heartbeat {
  event: 'worker.heartbeat';
  service: 'lembar-worker';
  name: string;
  version: string;
  emittedAt: string;
  // Deterministic id derived only from name+version+tick — no secrets, no PII.
  id: string;
}

export interface WorkerRuntimeOptions {
  name: string;
  version: string;
  tick: number;
}

export function resolveWorkerOptions(env: NodeJS.ProcessEnv = process.env): WorkerRuntimeOptions {
  const name = env['WORKER_NAME'] ?? 'lembar-worker';
  const version = env['npm_package_version'] ?? '0.0.0-b001';
  return { name, version, tick: 1 };
}

export function buildHeartbeat(options: WorkerRuntimeOptions, now: Date = new Date()): Heartbeat {
  const id = createHash('sha256')
    .update(`${options.name}|${options.version}|${options.tick}`)
    .digest('hex')
    .slice(0, 16);
  return {
    event: 'worker.heartbeat',
    service: 'lembar-worker',
    name: options.name,
    version: options.version,
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
