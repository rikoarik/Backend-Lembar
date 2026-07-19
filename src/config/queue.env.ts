import { ConfigError, type ConfigIssue } from './errors.js';

export const QUEUE_DRIVERS = ['memory', 'custom-postgres-only'] as const;
export type QueueDriver = (typeof QUEUE_DRIVERS)[number];

export interface QueueEnv {
  driver: QueueDriver;
  workerConcurrency: number;
  perWorkspaceConcurrency: number;
  perWorkspaceRateLimit: number;
  leaseTtlMs: number;
  leaseSafetyMarginMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  depthAlertThreshold: number;
}

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseDriver(raw: string | undefined, issues: ConfigIssue[]): QueueDriver {
  const fallback: QueueDriver = 'memory';
  if (raw === undefined) return fallback;
  if ((QUEUE_DRIVERS as readonly string[]).includes(raw)) return raw as QueueDriver;
  issues.push({ key: 'QUEUE_DRIVER', reason: `must be one of ${QUEUE_DRIVERS.join('|')}` });
  return fallback;
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  issues: ConfigIssue[],
  key: string,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    issues.push({ key, reason: `must be an integer in ${min}..${max}` });
    return fallback;
  }
  return n;
}

export function parseQueueEnv(env: NodeJS.ProcessEnv = process.env): QueueEnv {
  const issues: ConfigIssue[] = [];
  const driver = parseDriver(readString(env, 'QUEUE_DRIVER'), issues);
  const workerConcurrency = parseBoundedInt(
    readString(env, 'QUEUE_WORKER_CONCURRENCY'),
    4,
    1,
    64,
    issues,
    'QUEUE_WORKER_CONCURRENCY',
  );
  const perWorkspaceConcurrency = parseBoundedInt(
    readString(env, 'QUEUE_WORKSPACE_CONCURRENCY'),
    1,
    1,
    64,
    issues,
    'QUEUE_WORKSPACE_CONCURRENCY',
  );
  const perWorkspaceRateLimit = parseBoundedInt(
    readString(env, 'QUEUE_WORKSPACE_RATE_LIMIT'),
    10,
    1,
    10_000,
    issues,
    'QUEUE_WORKSPACE_RATE_LIMIT',
  );
  const leaseTtlMs = parseBoundedInt(
    readString(env, 'QUEUE_LEASE_TTL_MS'),
    30_000,
    100,
    3_600_000,
    issues,
    'QUEUE_LEASE_TTL_MS',
  );
  const leaseSafetyMarginMs = parseBoundedInt(
    readString(env, 'QUEUE_LEASE_SAFETY_MS'),
    5_000,
    0,
    3_600_000,
    issues,
    'QUEUE_LEASE_SAFETY_MS',
  );
  const maxAttempts = parseBoundedInt(
    readString(env, 'QUEUE_MAX_ATTEMPTS'),
    3,
    1,
    20,
    issues,
    'QUEUE_MAX_ATTEMPTS',
  );
  const backoffBaseMs = parseBoundedInt(
    readString(env, 'QUEUE_BACKOFF_BASE_MS'),
    500,
    1,
    600_000,
    issues,
    'QUEUE_BACKOFF_BASE_MS',
  );
  const backoffMaxMs = parseBoundedInt(
    readString(env, 'QUEUE_BACKOFF_MAX_MS'),
    30_000,
    1,
    3_600_000,
    issues,
    'QUEUE_BACKOFF_MAX_MS',
  );
  const depthAlertThreshold = parseBoundedInt(
    readString(env, 'QUEUE_DEPTH_ALERT'),
    50,
    1,
    1_000_000,
    issues,
    'QUEUE_DEPTH_ALERT',
  );

  if (issues.length > 0) throw new ConfigError(issues);

  return {
    driver,
    workerConcurrency,
    perWorkspaceConcurrency,
    perWorkspaceRateLimit,
    leaseTtlMs,
    leaseSafetyMarginMs,
    maxAttempts,
    backoffBaseMs,
    backoffMaxMs,
    depthAlertThreshold,
  };
}

export const queueEnv = parseQueueEnv;
