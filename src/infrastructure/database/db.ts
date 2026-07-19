import { setTimeout as delay } from 'node:timers/promises';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

import * as schema from './schema.js';

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;

export interface CreateDatabaseOptions {
  connectionString: string;
  poolMax?: number;
  ssl?: PoolConfig['ssl'];
  healthcheckTimeoutMs?: number;
}

export interface HealthcheckResult {
  ok: boolean;
  latencyMs: number;
  error?: { name: string; message: string };
}

const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 2000;

function redactError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: 'Error', message: 'unknown error' };
}

interface ManagedPool {
  readonly pool: Pool;
  readonly db: Database;
  closed: boolean;
}

const pools = new WeakMap<Database, ManagedPool>();

export function createDatabase(options: CreateDatabaseOptions): Database {
  const poolConfig: PoolConfig = {
    connectionString: options.connectionString,
    max: options.poolMax ?? 10,
    ssl: options.ssl ?? false,
    application_name: 'lembar-backend',
  };

  const pool = new Pool(poolConfig);
  const db = drizzle(pool, { schema });
  pools.set(db, { pool, db, closed: false });
  return db;
}

export function getPool(db: Database): Pool | undefined {
  const managed = pools.get(db);
  return managed?.pool;
}

export async function closeDatabase(db: Database): Promise<void> {
  const managed = pools.get(db);
  if (!managed || managed.closed) return;
  managed.closed = true;
  await managed.pool.end();
}

export async function healthcheck(
  db: Database,
  timeoutMs: number = DEFAULT_HEALTHCHECK_TIMEOUT_MS,
): Promise<HealthcheckResult> {
  const started = Date.now();
  const pool = getPool(db);
  if (!pool) {
    return {
      ok: false,
      latencyMs: 0,
      error: { name: 'Error', message: 'database handle has no managed pool' },
    };
  }
  try {
    await Promise.race([
      pool.query('select 1 as ok'),
      delay(timeoutMs, undefined, { ref: false }).then(() => {
        throw new Error(`healthcheck timeout after ${timeoutMs}ms`);
      }),
    ]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: redactError(err) };
  }
}
