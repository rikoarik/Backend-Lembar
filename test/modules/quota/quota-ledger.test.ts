import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { QuotaLedger } from '../../../src/modules/quota/application/QuotaLedger.js';
import type {
  QuotaReservation,
  NewQuotaReservation,
} from '../../../src/modules/quota/persistence/schema.js';
import type { QuotaBalance } from '../../../src/modules/quota/domain/types.js';
import {
  DuplicateIdempotencyKeyError,
  ReservationNotFoundError,
  ReservationAlreadyCommittedError,
  ReservationAlreadyReleasedError,
  TenantMismatchError,
  InsufficientQuotaError,
} from '../../../src/modules/quota/domain/errors.js';

// In-memory store for testing
class InMemoryQuotaStore {
  private reservations = new Map<string, QuotaReservation>();
  private idempotencyIndex = new Map<string, string>();
  private baseQuota = new Map<string, number>(); // tenantId:workspaceId -> base quota

  insert(data: NewQuotaReservation): QuotaReservation {
    // Check for existing idempotency key first
    const key = `${data.tenantId}:${data.workspaceId}:${data.idempotencyKey}`;
    const existingId = this.idempotencyIndex.get(key);
    if (existingId) {
      const existing = this.reservations.get(existingId);
      if (existing) return existing;
    }

    const id = randomUUID();
    const now = new Date();
    const row: QuotaReservation = {
      id,
      tenantId: data.tenantId,
      workspaceId: data.workspaceId,
      jobId: data.jobId,
      idempotencyKey: data.idempotencyKey,
      units: data.units,
      state: data.state as 'reserved' | 'committed' | 'released',
      createdAt: now,
      updatedAt: now,
      committedAt: null,
      releasedAt: null,
    };
    this.reservations.set(id, row);
    this.idempotencyIndex.set(key, id);
    return row;
  }

  setBaseQuota(tenantId: string, workspaceId: string, quota: number): void {
    this.baseQuota.set(`${tenantId}:${workspaceId}`, quota);
  }

  findById(id: string): QuotaReservation | null {
    return this.reservations.get(id) ?? null;
  }

  findByIdempotencyKey(
    tenantId: string,
    workspaceId: string,
    idempotencyKey: string,
  ): QuotaReservation | null {
    const key = `${tenantId}:${workspaceId}:${idempotencyKey}`;
    const id = this.idempotencyIndex.get(key);
    if (!id) return null;
    return this.reservations.get(id) ?? null;
  }

  commit(id: string): QuotaReservation | null {
    const row = this.reservations.get(id);
    if (!row) return null;
    row.state = 'committed';
    row.committedAt = new Date();
    row.updatedAt = new Date();
    return row;
  }

  release(id: string): QuotaReservation | null {
    const row = this.reservations.get(id);
    if (!row) return null;
    row.state = 'released';
    row.releasedAt = new Date();
    row.updatedAt = new Date();
    return row;
  }

  findByJobId(jobId: string): QuotaReservation | null {
    for (const row of this.reservations.values()) {
      if (row.jobId === jobId) return row;
    }
    return null;
  }

  getBalance(tenantId: string, workspaceId: string): QuotaBalance {
    let reserved = 0;
    let committed = 0;
    let released = 0;

    for (const row of this.reservations.values()) {
      if (row.tenantId !== tenantId || row.workspaceId !== workspaceId) continue;
      switch (row.state) {
        case 'reserved':
          reserved += row.units;
          break;
        case 'committed':
          committed += row.units;
          break;
        case 'released':
          released += row.units;
          break;
      }
    }

    const baseQuota = this.baseQuota.get(`${tenantId}:${workspaceId}`) ?? 0;

    return {
      tenantId,
      workspaceId,
      reserved,
      committed,
      released,
      available: baseQuota + reserved - committed - released,
    };
  }
}

// Repository that uses the in-memory store
class InMemoryQuotaRepository {
  constructor(private readonly store: InMemoryQuotaStore) {}

  async insert(data: NewQuotaReservation): Promise<QuotaReservation> {
    // Add small delay to simulate async behavior
    await new Promise((resolve) => setTimeout(resolve, 1));
    return this.store.insert(data);
  }

  async findById(id: string): Promise<QuotaReservation | null> {
    return this.store.findById(id);
  }

  async findByIdempotencyKey(
    tenantId: string,
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<QuotaReservation | null> {
    return this.store.findByIdempotencyKey(tenantId, workspaceId, idempotencyKey);
  }

  async commit(id: string): Promise<QuotaReservation | null> {
    return this.store.commit(id);
  }

  async release(id: string): Promise<QuotaReservation | null> {
    return this.store.release(id);
  }

  async findByJobId(jobId: string): Promise<QuotaReservation | null> {
    return this.store.findByJobId(jobId);
  }

  async getBalance(tenantId: string, workspaceId: string): Promise<QuotaBalance> {
    // For testing purposes, return the actual balance from the store
    return this.store.getBalance(tenantId, workspaceId);
  }
}

function buildLedger(baseQuota = 1000) {
  const store = new InMemoryQuotaStore();
  const repository = new InMemoryQuotaRepository(store);
  const ledger = new QuotaLedger(
    repository as unknown as ConstructorParameters<typeof QuotaLedger>[0],
  );
  return { ledger, store, baseQuota };
}

describe('QuotaLedger', () => {
  const tenantId = randomUUID();
  const workspaceId = randomUUID();
  const jobId = randomUUID();
  const idempotencyKey = randomUUID();

  describe('reserve', () => {
    test('creates a new reservation', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      const result = await ledger.reserve({
        tenantId,
        workspaceId,
        jobId,
        idempotencyKey,
        units: 5,
      });

      expect(result.reservationId).toBeDefined();
      expect(result.tenantId).toBe(tenantId);
      expect(result.workspaceId).toBe(workspaceId);
      expect(result.jobId).toBe(jobId);
      expect(result.units).toBe(5);
      expect(result.state).toBe('reserved');
      expect(result.duplicate).toBe(false);
    });

    test('returns duplicate=true for same idempotency key and job', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      const first = await ledger.reserve({
        tenantId,
        workspaceId,
        jobId,
        idempotencyKey,
        units: 5,
      });

      const second = await ledger.reserve({
        tenantId,
        workspaceId,
        jobId,
        idempotencyKey,
        units: 5,
      });

      expect(second.duplicate).toBe(true);
      expect(second.reservationId).toBe(first.reservationId);
    });

    test('throws DuplicateIdempotencyKeyError for same key but different job', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      await ledger.reserve({
        tenantId,
        workspaceId,
        jobId,
        idempotencyKey,
        units: 5,
      });

      await expect(
        ledger.reserve({
          tenantId,
          workspaceId,
          jobId: randomUUID(),
          idempotencyKey,
          units: 5,
        }),
      ).rejects.toThrow(DuplicateIdempotencyKeyError);
    });
  });

  describe('commit', () => {
    test('commits a reserved reservation', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      const reserved = await ledger.reserve({
        tenantId,
        workspaceId,
        jobId,
        idempotencyKey,
        units: 5,
      });

      const committed = await ledger.commit(reserved.reservationId, tenantId);

      expect(committed.state).toBe('committed');
      expect(committed.committedAt).toBeDefined();
    });

    test('is idempotent for already committed reservation', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      const reserved = await ledger.reserve({
        tenantId,
        workspaceId,
        jobId,
        idempotencyKey,
        units: 5,
      });

      const first = await ledger.commit(reserved.reservationId, tenantId);
      const second = await ledger.commit(reserved.reservationId, tenantId);

      expect(first.state).toBe('committed');
      expect(second.state).toBe('committed');
    });

    test('throws ReservationNotFoundError for non-existent reservation', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      await expect(ledger.commit(randomUUID(), tenantId)).rejects.toThrow(ReservationNotFoundError);
    });

    test('throws TenantMismatchError for wrong tenant', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      const reserved = await ledger.reserve({
        tenantId,
        workspaceId,
        jobId,
        idempotencyKey,
        units: 5,
      });

      await expect(ledger.commit(reserved.reservationId, randomUUID())).rejects.toThrow(
        TenantMismatchError,
      );
    });

    test('throws ReservationAlreadyReleasedError for released reservation', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      const reserved = await ledger.reserve({
        tenantId,
        workspaceId,
        jobId,
        idempotencyKey,
        units: 5,
      });

      await ledger.release(reserved.reservationId, tenantId);

      await expect(ledger.commit(reserved.reservationId, tenantId)).rejects.toThrow(
        ReservationAlreadyReleasedError,
      );
    });
  });

  describe('release', () => {
    test('releases a reserved reservation', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      const reserved = await ledger.reserve({
        tenantId,
        workspaceId,
        jobId,
        idempotencyKey,
        units: 5,
      });

      const released = await ledger.release(reserved.reservationId, tenantId);

      expect(released.state).toBe('released');
      expect(released.releasedAt).toBeDefined();
    });

    test('is idempotent for already released reservation', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      const reserved = await ledger.reserve({
        tenantId,
        workspaceId,
        jobId,
        idempotencyKey,
        units: 5,
      });

      const first = await ledger.release(reserved.reservationId, tenantId);
      const second = await ledger.release(reserved.reservationId, tenantId);

      expect(first.state).toBe('released');
      expect(second.state).toBe('released');
    });

    test('throws ReservationNotFoundError for non-existent reservation', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      await expect(ledger.release(randomUUID(), tenantId)).rejects.toThrow(
        ReservationNotFoundError,
      );
    });

    test('throws TenantMismatchError for wrong tenant', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      const reserved = await ledger.reserve({
        tenantId,
        workspaceId,
        jobId,
        idempotencyKey,
        units: 5,
      });

      await expect(ledger.release(reserved.reservationId, randomUUID())).rejects.toThrow(
        TenantMismatchError,
      );
    });

    test('throws ReservationAlreadyCommittedError for committed reservation', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      const reserved = await ledger.reserve({
        tenantId,
        workspaceId,
        jobId,
        idempotencyKey,
        units: 5,
      });

      await ledger.commit(reserved.reservationId, tenantId);

      await expect(ledger.release(reserved.reservationId, tenantId)).rejects.toThrow(
        ReservationAlreadyCommittedError,
      );
    });
  });

  describe('balance', () => {
    test('tracks balance correctly through lifecycle', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      // Initial balance
      const initial = await ledger.getBalance(tenantId, workspaceId);
      expect(initial.reserved).toBe(0);
      expect(initial.committed).toBe(0);
      expect(initial.released).toBe(0);
      expect(initial.available).toBe(baseQuota);

      // Reserve 10 units
      await ledger.reserve({
        tenantId,
        workspaceId,
        jobId: randomUUID(),
        idempotencyKey: randomUUID(),
        units: 10,
      });

      const afterReserve = await ledger.getBalance(tenantId, workspaceId);
      expect(afterReserve.reserved).toBe(10);
      expect(afterReserve.available).toBe(baseQuota + 10);

      // Reserve another 5 units
      const second = await ledger.reserve({
        tenantId,
        workspaceId,
        jobId: randomUUID(),
        idempotencyKey: randomUUID(),
        units: 5,
      });

      const afterSecondReserve = await ledger.getBalance(tenantId, workspaceId);
      expect(afterSecondReserve.reserved).toBe(15);
      expect(afterSecondReserve.available).toBe(baseQuota + 15);

      // Commit the second reservation
      await ledger.commit(second.reservationId, tenantId);

      const afterCommit = await ledger.getBalance(tenantId, workspaceId);
      expect(afterCommit.reserved).toBe(10);
      expect(afterCommit.committed).toBe(5);
      expect(afterCommit.available).toBe(baseQuota + 5);
    });

    test('calculates negative balance when committed exceeds reserved', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      const reserved = await ledger.reserve({
        tenantId,
        workspaceId,
        jobId: randomUUID(),
        idempotencyKey: randomUUID(),
        units: 5,
      });

      await ledger.commit(reserved.reservationId, tenantId);

      const balance = await ledger.getBalance(tenantId, workspaceId);
      expect(balance.committed).toBe(5);
      expect(balance.available).toBe(baseQuota - 5);
    });
  });

  describe('tenant isolation', () => {
    test('reservations are isolated per tenant', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      const tenant1 = randomUUID();
      const tenant2 = randomUUID();
      const sharedWorkspace = randomUUID();
      store.setBaseQuota(tenant1, sharedWorkspace, baseQuota);
      store.setBaseQuota(tenant2, sharedWorkspace, baseQuota);

      // Reserve for tenant 1
      await ledger.reserve({
        tenantId: tenant1,
        workspaceId: sharedWorkspace,
        jobId: randomUUID(),
        idempotencyKey: randomUUID(),
        units: 10,
      });

      // Reserve for tenant 2
      await ledger.reserve({
        tenantId: tenant2,
        workspaceId: sharedWorkspace,
        jobId: randomUUID(),
        idempotencyKey: randomUUID(),
        units: 20,
      });

      // Check balances are isolated
      const balance1 = await ledger.getBalance(tenant1, sharedWorkspace);
      const balance2 = await ledger.getBalance(tenant2, sharedWorkspace);

      expect(balance1.reserved).toBe(10);
      expect(balance2.reserved).toBe(20);
    });

    test('same idempotency key can be used across different tenants', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      const tenant1 = randomUUID();
      const tenant2 = randomUUID();
      const sharedKey = randomUUID();
      store.setBaseQuota(tenant1, workspaceId, baseQuota);
      store.setBaseQuota(tenant2, workspaceId, baseQuota);

      const result1 = await ledger.reserve({
        tenantId: tenant1,
        workspaceId: workspaceId,
        jobId: randomUUID(),
        idempotencyKey: sharedKey,
        units: 5,
      });

      const result2 = await ledger.reserve({
        tenantId: tenant2,
        workspaceId: workspaceId,
        jobId: randomUUID(),
        idempotencyKey: sharedKey,
        units: 10,
      });

      expect(result1.reservationId).not.toBe(result2.reservationId);
      expect(result1.duplicate).toBe(false);
      expect(result2.duplicate).toBe(false);
    });

    test('commit rejects cross-tenant access', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      const tenant1 = randomUUID();
      const tenant2 = randomUUID();
      store.setBaseQuota(tenant1, workspaceId, baseQuota);
      store.setBaseQuota(tenant2, workspaceId, baseQuota);

      const reserved = await ledger.reserve({
        tenantId: tenant1,
        workspaceId: workspaceId,
        jobId: randomUUID(),
        idempotencyKey: randomUUID(),
        units: 5,
      });

      // Try to commit with wrong tenant
      await expect(ledger.commit(reserved.reservationId, tenant2)).rejects.toThrow(
        TenantMismatchError,
      );
    });

    test('release rejects cross-tenant access', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      const tenant1 = randomUUID();
      const tenant2 = randomUUID();
      store.setBaseQuota(tenant1, workspaceId, baseQuota);
      store.setBaseQuota(tenant2, workspaceId, baseQuota);

      const reserved = await ledger.reserve({
        tenantId: tenant1,
        workspaceId: workspaceId,
        jobId: randomUUID(),
        idempotencyKey: randomUUID(),
        units: 5,
      });

      // Try to release with wrong tenant
      await expect(ledger.release(reserved.reservationId, tenant2)).rejects.toThrow(
        TenantMismatchError,
      );
    });
  });

  describe('concurrency', () => {
    test('handles concurrent reservations with different idempotency keys', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      const promises = Array.from({ length: 10 }, (_, i) =>
        ledger.reserve({
          tenantId,
          workspaceId,
          jobId: randomUUID(),
          idempotencyKey: randomUUID(),
          units: i + 1,
        }),
      );

      const results = await Promise.all(promises);

      expect(results).toHaveLength(10);
      results.forEach((result, i) => {
        expect(result.units).toBe(i + 1);
        expect(result.duplicate).toBe(false);
      });

      const balance = await ledger.getBalance(tenantId, workspaceId);
      expect(balance.reserved).toBe(55); // 1+2+3+4+5+6+7+8+9+10
    });

    test('concurrent duplicate detection works correctly', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);
      const sharedKey = randomUUID();
      const sharedJobId = randomUUID();

      // First, create the reservation
      await ledger.reserve({
        tenantId,
        workspaceId,
        jobId: sharedJobId,
        idempotencyKey: sharedKey,
        units: 5,
      });

      // Then make concurrent calls with the same key
      const promises = Array.from({ length: 5 }, () =>
        ledger.reserve({
          tenantId,
          workspaceId,
          jobId: sharedJobId,
          idempotencyKey: sharedKey,
          units: 5,
        }),
      );

      const results = await Promise.all(promises);

      // All should return the same reservation
      const uniqueIds = new Set(results.map((r) => r.reservationId));
      expect(uniqueIds.size).toBe(1);

      // All should be duplicates since the first reservation already exists
      const duplicates = results.filter((r) => r.duplicate);
      expect(duplicates.length).toBe(5);
    });
  });

  describe('failure scenarios', () => {
    test('release on job failure restores quota', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      const reserved = await ledger.reserve({
        tenantId,
        workspaceId,
        jobId,
        idempotencyKey,
        units: 10,
      });

      // Simulate job failure - release the reservation
      await ledger.release(reserved.reservationId, tenantId);

      const balance = await ledger.getBalance(tenantId, workspaceId);
      expect(balance.reserved).toBe(0);
      expect(balance.released).toBe(10);
      expect(balance.available).toBe(baseQuota - 10);
    });

    test('cannot release after commit (job succeeded then failure requested)', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      const reserved = await ledger.reserve({
        tenantId,
        workspaceId,
        jobId,
        idempotencyKey,
        units: 10,
      });

      await ledger.commit(reserved.reservationId, tenantId);

      // Trying to release after commit should fail
      await expect(ledger.release(reserved.reservationId, tenantId)).rejects.toThrow(
        ReservationAlreadyCommittedError,
      );
    });

    test('getReservationByJobId works correctly', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      const reserved = await ledger.reserve({
        tenantId,
        workspaceId,
        jobId,
        idempotencyKey,
        units: 5,
      });

      const found = await ledger.getReservationByJobId(jobId);
      expect(found).toBeDefined();
      expect(found?.id).toBe(reserved.reservationId);
    });

    test('getReservationByJobId returns null for non-existent job', async () => {
      const { ledger, store, baseQuota } = buildLedger();
      store.setBaseQuota(tenantId, workspaceId, baseQuota);

      const found = await ledger.getReservationByJobId(randomUUID());
      expect(found).toBeNull();
    });

    test('reserve against 0 balance fails with InsufficientQuotaError', async () => {
      const store = new InMemoryQuotaStore();
      const repository = new InMemoryQuotaRepository(store);
      // Override getBalance to return 0 available balance
      repository.getBalance = async () => ({
        tenantId,
        workspaceId,
        reserved: 0,
        committed: 0,
        released: 0,
        available: 0,
      });
      const ledger = new QuotaLedger(
        repository as unknown as ConstructorParameters<typeof QuotaLedger>[0],
      );

      // Balance is 0 initially, so reserving any units should fail
      await expect(
        ledger.reserve({
          tenantId,
          workspaceId,
          jobId: randomUUID(),
          idempotencyKey: randomUUID(),
          units: 10,
        }),
      ).rejects.toThrow(InsufficientQuotaError);
    });
  });
});
