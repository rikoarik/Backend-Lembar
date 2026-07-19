import type { QueueStore } from '../queue-store.js';

/** Stub for the rejected D-004 option. Kept only to document the seam. */
export class BullMqQueueStore implements QueueStore {
  constructor() {
    throw new Error('BullMQ/Redis was not selected for B0-06; use the Postgres-only adapter seam.');
  }

  insertJob(): never {
    throw new Error('unreachable');
  }
  getJob(): never {
    throw new Error('unreachable');
  }
  getIdempotency(): never {
    throw new Error('unreachable');
  }
  insertIdempotency(): never {
    throw new Error('unreachable');
  }
  nextClaimable(): never {
    throw new Error('unreachable');
  }
  reserveClaim(): never {
    throw new Error('unreachable');
  }
  releaseClaim(): never {
    throw new Error('unreachable');
  }
  reapExpired(): never {
    throw new Error('unreachable');
  }
  heartbeat(): never {
    throw new Error('unreachable');
  }
  finalizeSuccess(): never {
    throw new Error('unreachable');
  }
  finalizeFailure(): never {
    throw new Error('unreachable');
  }
  rescheduleRetry(): never {
    throw new Error('unreachable');
  }
  markDeadLetter(): never {
    throw new Error('unreachable');
  }
  requestCancel(): never {
    throw new Error('unreachable');
  }
  auditRecover(): never {
    throw new Error('unreachable');
  }
  queueDepth(): never {
    throw new Error('unreachable');
  }
  auditEvents(): never {
    throw new Error('unreachable');
  }
}
