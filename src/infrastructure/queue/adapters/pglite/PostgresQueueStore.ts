import type { QueueStore } from '../queue-store.js';

/**
 * Production-shaped Postgres adapter seam for D-004.
 *
 * B0-06 proves the contract with the local in-memory adapter and the Drizzle schema/SQL
 * migration. Later tasks wire these methods to transactional Drizzle queries without
 * changing the QueueStore interface.
 */
export class PostgresQueueStore implements QueueStore {
  constructor(private readonly _db: unknown) {}

  private unsupported(): never {
    throw new Error('PostgresQueueStore wiring is deferred after B0-06 ADR acceptance');
  }

  insertJob(): never {
    return this.unsupported();
  }
  getJob(): never {
    return this.unsupported();
  }
  getIdempotency(): never {
    return this.unsupported();
  }
  insertIdempotency(): never {
    return this.unsupported();
  }
  nextClaimable(): never {
    return this.unsupported();
  }
  reserveClaim(): never {
    return this.unsupported();
  }
  releaseClaim(): never {
    return this.unsupported();
  }
  reapExpired(): never {
    return this.unsupported();
  }
  heartbeat(): never {
    return this.unsupported();
  }
  finalizeSuccess(): never {
    return this.unsupported();
  }
  finalizeFailure(): never {
    return this.unsupported();
  }
  rescheduleRetry(): never {
    return this.unsupported();
  }
  markDeadLetter(): never {
    return this.unsupported();
  }
  requestCancel(): never {
    return this.unsupported();
  }
  auditRecover(): never {
    return this.unsupported();
  }
  queueDepth(): never {
    return this.unsupported();
  }
  auditEvents(): never {
    return this.unsupported();
  }
}
