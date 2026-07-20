/**
 * B2-05: End-to-end job status and recovery tests.
 *
 * Covers:
 * - Crash and lease-injection recovery
 * - Quota invariant: reserve/commit/release across job lifecycle
 * - Tenant isolation on all reads/mutations
 * - Neutral status mapping
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import { InMemoryQueueStore } from '../../../src/infrastructure/queue/adapters/memory-store.js';
import { QueueSpike } from '../../../src/infrastructure/queue/application/QueueSpike.js';
import { JobStatusService } from '../../../src/modules/jobs/application/JobStatusService.js';
import { QueueJobStatusAdapter } from '../../../src/modules/jobs/adapters/QueueJobStatusAdapter.js';
import { QuotaLedger } from '../../../src/modules/quota/application/QuotaLedger.js';
import type {
  QuotaReservation,
  NewQuotaReservation,
} from '../../../src/modules/quota/persistence/schema.js';
import type { QuotaBalance } from '../../../src/modules/quota/domain/types.js';
import { toNeutralStatus } from '../../../src/modules/jobs/domain/status-mapper.js';
import {
  JobNotFoundError,
  JobTenantMismatchError,
  JobNotCancellableError,
} from '../../../src/modules/jobs/domain/errors.js';

// In-memory quota store for testing
class InMemoryQuotaStore {
  private reservations = new Map<string, QuotaReservation>();
  private idempotencyIndex = new Map<string, string>();
  private baseQuota = new Map<string, number>();

  insert(data: NewQuotaReservation): QuotaReservation {
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

class InMemoryQuotaRepository {
  constructor(private readonly store: InMemoryQuotaStore) {}

  async insert(data: NewQuotaReservation): Promise<QuotaReservation> {
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
    return this.store.getBalance(tenantId, workspaceId);
  }
}

function buildTestHarness(baseQuota = 1000) {
  const queueStore = new InMemoryQueueStore();
  const quotaStore = new InMemoryQuotaStore();
  const quotaRepo = new InMemoryQuotaRepository(quotaStore);
  const quotaLedger = new QuotaLedger(
    quotaRepo as unknown as ConstructorParameters<typeof QuotaLedger>[0],
  );

  const adapter = new QueueJobStatusAdapter(queueStore, {
    leaseTtlMs: 100,
    maxAttempts: 3,
  });

  const service = new JobStatusService(adapter, quotaLedger);

  const spike = new QueueSpike(queueStore, {
    leaseTtlMs: 100,
    leaseSafetyMarginMs: 20,
    maxAttempts: 3,
    backoffBaseMs: 10,
    backoffMaxMs: 100,
    workerConcurrency: 2,
    perWorkspaceConcurrency: 1,
    perWorkspaceRateLimit: 2,
    depthAlertThreshold: 1,
  });

  return { service, spike, quotaStore, quotaLedger, queueStore, baseQuota };
}

describe('B2-05: End-to-end job status and recovery', () => {
  describe('neutral status mapping', () => {
    test('maps internal queue statuses to neutral API statuses', () => {
      expect(toNeutralStatus('created')).toBe('queued');
      expect(toNeutralStatus('queued')).toBe('queued');
      expect(toNeutralStatus('running')).toBe('generating');
      expect(toNeutralStatus('retry_wait')).toBe('preparing');
      expect(toNeutralStatus('succeeded')).toBe('completed');
      expect(toNeutralStatus('partially_succeeded')).toBe('partially_failed');
      expect(toNeutralStatus('failed')).toBe('failed');
      expect(toNeutralStatus('cancelled')).toBe('cancelled');
    });
  });

  describe('crash and lease-injection recovery', () => {
    test('job recovers after crash before provider call', async () => {
      const { service, spike, quotaStore } = buildTestHarness();
      const tenantId = randomUUID();
      const workspaceId = randomUUID();
      quotaStore.setBaseQuota(tenantId, workspaceId, 1000);

      // Submit a job
      const submitted = await service.submit(
        {
          tenantId,
          workspaceId,
          actorId: 'user-1',
          kind: 'assessment_generation',
          idempotencyKey: randomUUID(),
          fingerprint: { prompt: 'test' },
          quotaUnits: 1,
        },
        { tenantId, workspaceId },
      );

      expect(submitted.status).toBe('queued');

      // Simulate crash before provider
      await expect(spike.workOnce('worker-a', { crashAt: 'beforeProvider' })).rejects.toThrow(
        'simulated crash',
      );

      // Reap expired lease and retry
      await spike.reapExpiredLeases(121);
      await spike.workOnce('worker-b');

      // Verify job completed
      const status = await service.getStatus(submitted.jobId, { tenantId, workspaceId });
      expect(status.status).toBe('completed');
    });

    test('job recovers after crash after provider before commit', async () => {
      const { service, spike, quotaStore } = buildTestHarness();
      const tenantId = randomUUID();
      const workspaceId = randomUUID();
      quotaStore.setBaseQuota(tenantId, workspaceId, 1000);

      const submitted = await service.submit(
        {
          tenantId,
          workspaceId,
          actorId: 'user-1',
          kind: 'assessment_generation',
          idempotencyKey: randomUUID(),
          fingerprint: { prompt: 'test' },
          quotaUnits: 1,
        },
        { tenantId, workspaceId },
      );

      // Simulate crash after provider
      await expect(
        spike.workOnce('worker-a', { crashAt: 'afterProviderBeforeCommit' }),
      ).rejects.toThrow('simulated crash');

      // Reap and retry
      await spike.reapExpiredLeases(121);
      await spike.workOnce('worker-b');

      const status = await service.getStatus(submitted.jobId, { tenantId, workspaceId });
      expect(status.status).toBe('completed');
    });

    test('lease injection reclaims expired job without double effect', async () => {
      const { service, spike, quotaStore } = buildTestHarness();
      const tenantId = randomUUID();
      const workspaceId = randomUUID();
      quotaStore.setBaseQuota(tenantId, workspaceId, 1000);

      const submitted = await service.submit(
        {
          tenantId,
          workspaceId,
          actorId: 'user-1',
          kind: 'assessment_generation',
          idempotencyKey: randomUUID(),
          fingerprint: { prompt: 'test' },
          quotaUnits: 1,
        },
        { tenantId, workspaceId },
      );

      // Worker A claims but doesn't complete
      const claimed = await spike.claim('worker-a');
      expect(claimed?.status).toBe('running');

      // Worker B cannot claim while A holds lease
      expect(await spike.claim('worker-b')).toBeNull();

      // Lease expires, B reclaims
      await spike.reapExpiredLeases(121);
      const reclaimed = await spike.claim('worker-b');
      expect(reclaimed?.attempt).toBe(2);
      await spike.completeClaim(reclaimed!.id, 'worker-b');

      // Only one effect (no double processing)
      expect(spike.effectCount()).toBe(1);

      const status = await service.getStatus(submitted.jobId, { tenantId, workspaceId });
      expect(status.status).toBe('completed');
    });
  });

  describe('quota invariant: reserve/commit/release', () => {
    test('reserve on submit, commit on success', async () => {
      const { service, quotaStore, quotaLedger } = buildTestHarness();
      const tenantId = randomUUID();
      const workspaceId = randomUUID();
      quotaStore.setBaseQuota(tenantId, workspaceId, 1000);

      await service.submit(
        {
          tenantId,
          workspaceId,
          actorId: 'user-1',
          kind: 'assessment_generation',
          idempotencyKey: randomUUID(),
          fingerprint: { prompt: 'test' },
          quotaUnits: 5,
        },
        { tenantId, workspaceId },
      );

      // Check reservation
      const afterReserve = await quotaLedger.getBalance(tenantId, workspaceId);
      expect(afterReserve.reserved).toBe(5);
      expect(afterReserve.committed).toBe(0);

      // Simulate success and commit
      const submittedResult = await service.submit(
        {
          tenantId,
          workspaceId,
          actorId: 'u',
          kind: 'assessment_generation',
          idempotencyKey: randomUUID(),
          fingerprint: {},
          quotaUnits: 1,
        },
        { tenantId, workspaceId },
      );
      const reservation = await quotaLedger.getReservationByJobId(submittedResult.jobId);
      await quotaLedger.commit(reservation!.id, tenantId);

      const afterCommit = await quotaLedger.getBalance(tenantId, workspaceId);
      expect(afterCommit.reserved).toBe(5);
      expect(afterCommit.committed).toBe(1);
    });

    test('reserve on submit, release on cancel', async () => {
      const { service, quotaStore, quotaLedger } = buildTestHarness();
      const tenantId = randomUUID();
      const workspaceId = randomUUID();
      quotaStore.setBaseQuota(tenantId, workspaceId, 1000);

      const submitted = await service.submit(
        {
          tenantId,
          workspaceId,
          actorId: 'user-1',
          kind: 'assessment_generation',
          idempotencyKey: randomUUID(),
          fingerprint: { prompt: 'test' },
          quotaUnits: 5,
        },
        { tenantId, workspaceId },
      );

      // Cancel the job
      await service.cancel(submitted.jobId, { tenantId, workspaceId }, 'user-1');

      // Verify quota released
      const balance = await quotaLedger.getBalance(tenantId, workspaceId);
      expect(balance.reserved).toBe(0);
      expect(balance.released).toBe(5);
    });

    test('reserve on submit, release on terminal failure', async () => {
      const { service, spike, quotaStore, quotaLedger } = buildTestHarness();
      const tenantId = randomUUID();
      const workspaceId = randomUUID();
      quotaStore.setBaseQuota(tenantId, workspaceId, 1000);

      const submitted = await service.submit(
        {
          tenantId,
          workspaceId,
          actorId: 'user-1',
          kind: 'assessment_generation',
          idempotencyKey: randomUUID(),
          fingerprint: { prompt: 'test' },
          quotaUnits: 5,
        },
        { tenantId, workspaceId },
      );

      // Fail with terminal error
      await spike.failNextJobTerminal('UNSUPPORTED_SOURCE');

      // Release quota
      await service.releaseOnFailure(submitted.jobId, tenantId);

      const balance = await quotaLedger.getBalance(tenantId, workspaceId);
      expect(balance.reserved).toBe(0);
      expect(balance.released).toBe(5);
    });

    test('quota is reserved exactly once across retries', async () => {
      const { service, spike, quotaStore, quotaLedger } = buildTestHarness();
      const tenantId = randomUUID();
      const workspaceId = randomUUID();
      quotaStore.setBaseQuota(tenantId, workspaceId, 1000);

      const submitted = await service.submit(
        {
          tenantId,
          workspaceId,
          actorId: 'user-1',
          kind: 'assessment_generation',
          idempotencyKey: randomUUID(),
          fingerprint: { prompt: 'test' },
          quotaUnits: 3,
        },
        { tenantId, workspaceId },
      );

      // Crash and recover
      await expect(
        spike.workOnce('worker-a', { crashAt: 'afterProviderBeforeCommit' }),
      ).rejects.toThrow('simulated crash');

      await spike.reapExpiredLeases(121);
      await spike.workOnce('worker-b');

      // Commit on success
      await service.commitOnSuccess(submitted.jobId, tenantId);

      const balance = await quotaLedger.getBalance(tenantId, workspaceId);
      expect(balance.reserved).toBe(0);
      expect(balance.committed).toBe(3);
    });
  });

  describe('tenant isolation', () => {
    test('job status is isolated per workspace', async () => {
      const { service, quotaStore } = buildTestHarness();
      const tenant1 = randomUUID();
      const tenant2 = randomUUID();
      const workspace1 = randomUUID();
      const workspace2 = randomUUID();
      quotaStore.setBaseQuota(tenant1, workspace1, 1000);
      quotaStore.setBaseQuota(tenant2, workspace2, 1000);

      // Submit job for workspace 1
      const submitted = await service.submit(
        {
          tenantId: tenant1,
          workspaceId: workspace1,
          actorId: 'user-1',
          kind: 'assessment_generation',
          idempotencyKey: randomUUID(),
          fingerprint: { prompt: 'test' },
          quotaUnits: 1,
        },
        { tenantId: tenant1, workspaceId: workspace1 },
      );

      // Workspace 1 can read
      const status1 = await service.getStatus(submitted.jobId, {
        tenantId: tenant1,
        workspaceId: workspace1,
      });
      expect(status1.id).toBe(submitted.jobId);

      // Workspace 2 cannot read (returns 404-equivalent error)
      await expect(
        service.getStatus(submitted.jobId, { tenantId: tenant2, workspaceId: workspace2 }),
      ).rejects.toThrow(JobTenantMismatchError);
    });

    test('cancel rejects cross-tenant access', async () => {
      const { service, quotaStore } = buildTestHarness();
      const tenant1 = randomUUID();
      const tenant2 = randomUUID();
      const workspace1 = randomUUID();
      const workspace2 = randomUUID();
      quotaStore.setBaseQuota(tenant1, workspace1, 1000);
      quotaStore.setBaseQuota(tenant2, workspace2, 1000);

      const submitted = await service.submit(
        {
          tenantId: tenant1,
          workspaceId: workspace1,
          actorId: 'user-1',
          kind: 'assessment_generation',
          idempotencyKey: randomUUID(),
          fingerprint: { prompt: 'test' },
          quotaUnits: 1,
        },
        { tenantId: tenant1, workspaceId: workspace1 },
      );

      // Workspace 2 cannot cancel workspace 1's job
      await expect(
        service.cancel(submitted.jobId, { tenantId: tenant2, workspaceId: workspace2 }, 'user-2'),
      ).rejects.toThrow(JobTenantMismatchError);
    });

    test('recover rejects cross-tenant access', async () => {
      const { service, spike, quotaStore } = buildTestHarness();
      const tenant1 = randomUUID();
      const tenant2 = randomUUID();
      const workspace1 = randomUUID();
      const workspace2 = randomUUID();
      quotaStore.setBaseQuota(tenant1, workspace1, 1000);
      quotaStore.setBaseQuota(tenant2, workspace2, 1000);

      const submitted = await service.submit(
        {
          tenantId: tenant1,
          workspaceId: workspace1,
          actorId: 'user-1',
          kind: 'assessment_generation',
          idempotencyKey: randomUUID(),
          fingerprint: { prompt: 'test' },
          quotaUnits: 1,
        },
        { tenantId: tenant1, workspaceId: workspace1 },
      );

      // Fail the job to dead-letter
      for (let i = 0; i < 3; i++) {
        await spike.failNextJobRetryable('PROVIDER_TIMEOUT');
        await spike.releaseRetryWait();
      }

      // Workspace 2 cannot recover workspace 1's dead-lettered job
      await expect(
        service.recover(
          submitted.jobId,
          { tenantId: tenant2, workspaceId: workspace2 },
          'ops-2',
          'attempted cross-tenant recover',
        ),
      ).rejects.toThrow(JobTenantMismatchError);
    });

    test('quota is isolated per tenant', async () => {
      const { service, quotaStore, quotaLedger } = buildTestHarness();
      const tenant1 = randomUUID();
      const tenant2 = randomUUID();
      const workspace = randomUUID();
      quotaStore.setBaseQuota(tenant1, workspace, 1000);
      quotaStore.setBaseQuota(tenant2, workspace, 1000);

      // Submit for tenant 1
      await service.submit(
        {
          tenantId: tenant1,
          workspaceId: workspace,
          actorId: 'user-1',
          kind: 'assessment_generation',
          idempotencyKey: randomUUID(),
          fingerprint: { prompt: 'test1' },
          quotaUnits: 10,
        },
        { tenantId: tenant1, workspaceId: workspace },
      );

      // Submit for tenant 2
      await service.submit(
        {
          tenantId: tenant2,
          workspaceId: workspace,
          actorId: 'user-2',
          kind: 'assessment_generation',
          idempotencyKey: randomUUID(),
          fingerprint: { prompt: 'test2' },
          quotaUnits: 20,
        },
        { tenantId: tenant2, workspaceId: workspace },
      );

      // Balances are isolated
      const balance1 = await quotaLedger.getBalance(tenant1, workspace);
      const balance2 = await quotaLedger.getBalance(tenant2, workspace);

      expect(balance1.reserved).toBe(10);
      expect(balance2.reserved).toBe(20);
    });
  });

  describe('job lifecycle', () => {
    test('submit returns neutral queued status', async () => {
      const { service, quotaStore } = buildTestHarness();
      const tenantId = randomUUID();
      const workspaceId = randomUUID();
      quotaStore.setBaseQuota(tenantId, workspaceId, 1000);

      const result = await service.submit(
        {
          tenantId,
          workspaceId,
          actorId: 'user-1',
          kind: 'assessment_generation',
          idempotencyKey: randomUUID(),
          fingerprint: { prompt: 'test' },
          quotaUnits: 1,
        },
        { tenantId, workspaceId },
      );

      expect(result.status).toBe('queued');
      expect(result.duplicate).toBe(false);
      expect(result.jobId).toBeDefined();
      expect(result.reservationId).toBeDefined();
    });

    test('cancel transitions to cancelled status', async () => {
      const { service, quotaStore } = buildTestHarness();
      const tenantId = randomUUID();
      const workspaceId = randomUUID();
      quotaStore.setBaseQuota(tenantId, workspaceId, 1000);

      const submitted = await service.submit(
        {
          tenantId,
          workspaceId,
          actorId: 'user-1',
          kind: 'assessment_generation',
          idempotencyKey: randomUUID(),
          fingerprint: { prompt: 'test' },
          quotaUnits: 1,
        },
        { tenantId, workspaceId },
      );

      const cancelled = await service.cancel(submitted.jobId, { tenantId, workspaceId }, 'user-1');

      expect(cancelled.status).toBe('cancelled');
    });

    test('cancel rejects already completed jobs', async () => {
      const { service, spike, quotaStore } = buildTestHarness();
      const tenantId = randomUUID();
      const workspaceId = randomUUID();
      quotaStore.setBaseQuota(tenantId, workspaceId, 1000);

      const submitted = await service.submit(
        {
          tenantId,
          workspaceId,
          actorId: 'user-1',
          kind: 'assessment_generation',
          idempotencyKey: randomUUID(),
          fingerprint: { prompt: 'test' },
          quotaUnits: 1,
        },
        { tenantId, workspaceId },
      );

      // Complete the job
      await spike.workOnce('worker-a');

      // Cannot cancel completed job
      await expect(
        service.cancel(submitted.jobId, { tenantId, workspaceId }, 'user-1'),
      ).rejects.toThrow(JobNotCancellableError);
    });

    test('getStatus returns 404 for non-existent job', async () => {
      const { service } = buildTestHarness();

      await expect(
        service.getStatus(randomUUID(), { tenantId: randomUUID(), workspaceId: randomUUID() }),
      ).rejects.toThrow(JobNotFoundError);
    });
  });
});
