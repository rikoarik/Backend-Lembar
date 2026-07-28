import { createDatabase } from '../database/db.js';
import { InMemoryQueueStore } from './adapters/memory-store.js';
import { PostgresQueueStore } from './adapters/pglite/PostgresQueueStore.js';
import type { QueueStore } from './adapters/queue-store.js';

/**
 * Build the queue store the API and worker share.
 *
 * Production uses the Postgres-backed adapter when `DATABASE_URL` is set so
 * job submissions from the API become visible to the worker process. Local
 * smoke and tests without a database fall back to the in-memory store.
 *
 * ponytail: the in-memory fallback is single-process. Two processes (API +
 * worker) running with this fallback WILL NOT see each other's jobs. The
 * worker crash-loop skill flagged this exact regression before.
 */
export function createSharedQueueStore(env: NodeJS.ProcessEnv = process.env): QueueStore {
  const url = env['DATABASE_URL'];
  if (url && url.length > 0) {
    const db = createDatabase({ connectionString: url });
    return new PostgresQueueStore(db);
  }
  return new InMemoryQueueStore();
}