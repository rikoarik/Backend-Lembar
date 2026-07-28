import { randomUUID } from 'node:crypto';

import type { QueueStore, QueueStoreJob } from '../queue-store.js';

/** Stub for the rejected D-004 option. Kept only to document the seam. */
export class BullMqQueueStore implements QueueStore {
  constructor() {
    throw new Error('BullMQ/Redis was not selected for B0-06; use the Postgres-only adapter seam.');
  }

  private unsupported(): never {
    throw new Error('BullMqQueueStore is a stub seam and is not wired in this build.');
  }

  newId(): string {
    return randomUUID();
  }

  getJobSync(_id: string): QueueStoreJob | null {
    return this.unsupported();
  }

  insertJob(): never { return this.unsupported(); }
  getJob(): never { return this.unsupported(); }
  getIdempotency(): never { return this.unsupported(); }
  insertIdempotency(): never { return this.unsupported(); }
  nextClaimable(): never { return this.unsupported(); }
  reserveClaim(): never { return this.unsupported(); }
  releaseClaim(): never { return this.unsupported(); }
  reapExpired(): never { return this.unsupported(); }
  heartbeat(): never { return this.unsupported(); }
  finalizeSuccess(): never { return this.unsupported(); }
  finalizeFailure(): never { return this.unsupported(); }
  rescheduleRetry(): never { return this.unsupported(); }
  markDeadLetter(): never { return this.unsupported(); }
  requestCancel(): never { return this.unsupported(); }
  auditRecover(): never { return this.unsupported(); }
  queueDepth(): never { return this.unsupported(); }
  auditEvents(): never { return this.unsupported(); }
}
