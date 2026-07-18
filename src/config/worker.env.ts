import { type BaseEnv, parseBaseEnv } from './base.env.js';
import { ConfigError, type ConfigIssue } from './errors.js';

export interface WorkerEnv extends BaseEnv {
  workerName: string;
  workerConcurrency: number;
}

function parseWorkerName(raw: string | undefined): string {
  return raw ?? 'lembar-worker';
}

function parseConcurrency(raw: string | undefined, issues: ConfigIssue[]): number {
  if (raw === undefined) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 64) {
    issues.push({ key: 'WORKER_CONCURRENCY', reason: 'must be an integer in 1..64' });
    return 1;
  }
  return n;
}

export function parseWorkerEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const base = parseBaseEnv(env);
  const issues: ConfigIssue[] = [];

  const workerName = parseWorkerName(env['WORKER_NAME']);
  const workerConcurrency = parseConcurrency(env['WORKER_CONCURRENCY'], issues);

  if (issues.length > 0) throw new ConfigError(issues);

  return { ...base, workerName, workerConcurrency };
}

export const workerEnv = parseWorkerEnv;
