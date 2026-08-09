import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, closeDatabase, type Database } from '../../../src/infrastructure/database/db.js';
import { InMemoryQueueStore } from '../../../src/infrastructure/queue/adapters/memory-store.js';
import { PostgresQueueStore } from '../../../src/infrastructure/queue/adapters/pglite/PostgresQueueStore.js';
import type { QueueStore, QueueStoreJob } from '../../../src/infrastructure/queue/adapters/queue-store.js';

const HAS_DB = Boolean(process.env['DATABASE_URL']);
const describeDb = HAS_DB ? describe : describe.skip;

describeDb('PostgresQueueStore contract parity', () => {
  let db: Database;
  let store: QueueStore;
  beforeAll(async () => {
    db = createDatabase({ connectionString: process.env['DATABASE_URL']! });
  });

  beforeEach(async () => {
    await db.execute(
      "DELETE FROM \"spike_idempotency_keys\" WHERE key LIKE 'pgstore-%'",
    );
    await db.execute(
      "DELETE FROM \"spike_jobs\" WHERE workspace_id LIKE 'pgstore-%'",
    );
    store = new PostgresQueueStore(db);
  });

  afterAll(async () => {
    await db.execute(
      "DELETE FROM \"spike_idempotency_keys\" WHERE key LIKE 'pgstore-%'",
    );
    await db.execute(
      "DELETE FROM \"spike_jobs\" WHERE workspace_id LIKE 'pgstore-%'",
    );
    await closeDatabase(db);
  });

  async function seedJob(overrides: Partial<QueueStoreJob> = {}): Promise<QueueStoreJob> {
    const id = overrides.id ?? randomUUID();
    const job: Omit<QueueStoreJob, 'createdAt' | 'updatedAt'> = {
      id,
      workspaceId: overrides.workspaceId ?? `pgstore-ws-${randomUUID()}`,
      actorId: overrides.actorId ?? 'actor-test',
      kind: overrides.kind ?? 'assessment_generation',
      status: overrides.status ?? 'queued',
      attempt: overrides.attempt ?? 0,
      maxAttempts: overrides.maxAttempts ?? 3,
      leaseTtlMs: overrides.leaseTtlMs ?? 30000,
      leaseExpiresAt: overrides.leaseExpiresAt ?? null,
      heartbeatAt: overrides.heartbeatAt ?? null,
      payload: overrides.payload ?? { hello: 'world' },
      quotaUnits: overrides.quotaUnits ?? 1,
      nextAttemptAt: overrides.nextAttemptAt ?? null,
      lastError: overrides.lastError ?? null,
    };
    return store.insertJob(job);
  }

  it('insertJob then getJob round-trips', async () => {
    const inserted = await seedJob({ payload: { assessmentVersionId: 'abc' } });
    const fetched = await store.getJob(inserted.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(inserted.id);
    expect(fetched?.status).toBe('queued');
    expect(fetched?.payload).toEqual({ assessmentVersionId: 'abc' });
    expect(fetched?.createdAt).toBeInstanceOf(Date);
  });

  it('insertIdempotency + getIdempotency returns the same record', async () => {
    await store.insertIdempotency({
      key: 'pgstore-key-1',
      workspaceId: 'pgstore-ws-idem',
      operation: 'assessment_generation',
      jobId: '00000000-0000-4000-8000-000000000001',
      fingerprint: 'fp-1',
    });
    const got = await store.getIdempotency({
      workspaceId: 'pgstore-ws-idem',
      operation: 'assessment_generation',
      key: 'pgstore-key-1',
    });
    expect(got?.jobId).toBe('00000000-0000-4000-8000-000000000001');
    expect(got?.fingerprint).toBe('fp-1');
  });

  it('nextClaimable returns oldest queued job not in exclude list', async () => {
    const existing = await db.execute<{ workspace_id: string }>(
      "SELECT DISTINCT workspace_id FROM spike_jobs WHERE status IN ('queued', 'retry_wait')",
    );
    await seedJob({ id: '00000000-0000-4000-8000-00000000000a', workspaceId: 'pgstore-ws-A' });
    await seedJob({ id: '00000000-0000-4000-8000-00000000000b', workspaceId: 'pgstore-ws-B' });
    const claim = await store.nextClaimable(
      new Date(),
      existing.rows.map((row) => row.workspace_id),
    );
    expect(claim?.id).toBe('00000000-0000-4000-8000-00000000000a');
  });

  it('nextClaimable respects excludeWorkspaceIds', async () => {
    const existing = await db.execute<{ workspace_id: string }>(
      "SELECT DISTINCT workspace_id FROM spike_jobs WHERE status IN ('queued', 'retry_wait')",
    );
    await seedJob({ id: '00000000-0000-4000-8000-00000000000c', workspaceId: 'pgstore-ws-X' });
    const claim = await store.nextClaimable(
      new Date(),
      [...existing.rows.map((row) => row.workspace_id), 'pgstore-ws-X'],
    );
    expect(claim).toBeNull();
  });

  it('reclaims an overdue retry_wait job', async () => {
    const id = '00000000-0000-4000-8000-000000000011';
    await seedJob({
      id,
      workspaceId: 'pgstore-ws-retry',
      status: 'retry_wait',
      attempt: 1,
      nextAttemptAt: new Date(Date.now() - 1000),
    });

    const existing = await db.execute<{ workspace_id: string }>(
      "SELECT DISTINCT workspace_id FROM spike_jobs WHERE status IN ('queued', 'retry_wait') AND workspace_id <> 'pgstore-ws-retry'",
    );
    expect((await store.nextClaimable(
      new Date(),
      existing.rows.map((row) => row.workspace_id),
    ))?.id).toBe(id);
    const reserved = await store.reserveClaim(id, 'worker-x', new Date(), 5000);
    expect(reserved?.status).toBe('running');
    expect(reserved?.attempt).toBe(2);
  });

  it('reserveClaim flips queued -> running and stores lease', async () => {
    const inserted = await seedJob({ id: '00000000-0000-4000-8000-00000000000d' });
    const reserved = await store.reserveClaim(inserted.id, 'worker-x', new Date(), 5000);
    expect(reserved?.status).toBe('running');
    expect(reserved?.attempt).toBe(1);
    expect(reserved?.leaseExpiresAt).toBeInstanceOf(Date);
  });

  it('finalizeSuccess sets succeeded and clears lease', async () => {
    await seedJob({ id: '00000000-0000-4000-8000-00000000000e' });
    await store.reserveClaim('00000000-0000-4000-8000-00000000000e', 'w', new Date(), 1000);
    const ok = await store.finalizeSuccess('00000000-0000-4000-8000-00000000000e', 'w', new Date());
    expect(ok?.status).toBe('succeeded');
    expect(ok?.leaseExpiresAt).toBeNull();
  });

  it('finalizeFailure captures the error envelope', async () => {
    await seedJob({ id: '00000000-0000-4000-8000-00000000000f' });
    await store.reserveClaim('00000000-0000-4000-8000-00000000000f', 'w', new Date(), 1000);
    const done = await store.finalizeFailure('00000000-0000-4000-8000-00000000000f', 'w', new Date(), {
      code: 'PROVIDER_ERROR',
      message: 'boom',
    });
    expect(done?.status).toBe('failed');
    expect((done?.lastError as { code?: string }).code).toBe('PROVIDER_ERROR');
  });

  it('parity: Postgres store and in-memory store agree on the same insert/claim/success sequence', async () => {
    const m = new InMemoryQueueStore();
    const params = {
      id: '00000000-0000-4000-8000-000000000010',
      workspaceId: 'pgstore-ws-par',
      actorId: 'actor-par',
      kind: 'assessment_generation' as const,
      payload: { parity: true },
      quotaUnits: 1,
      maxAttempts: 3,
      leaseTtlMs: 30000,
    };
    const memJob = await m.insertJob({ ...params, status: 'queued', attempt: 0, leaseExpiresAt: null, heartbeatAt: null, nextAttemptAt: null, lastError: null });
    const pgJob = await store.insertJob({ ...params, status: 'queued', attempt: 0, leaseExpiresAt: null, heartbeatAt: null, nextAttemptAt: null, lastError: null });

    expect(pgJob.payload).toEqual(memJob.payload);
    expect(pgJob.workspaceId).toBe(memJob.workspaceId);

    const memClaim = await m.reserveClaim(params.id, 'w', new Date(), 1000);
    const pgClaim = await store.reserveClaim(params.id, 'w', new Date(), 1000);
    expect(pgClaim?.status).toBe(memClaim?.status);
    expect(pgClaim?.attempt).toBe(memClaim?.attempt);

    const memOk = await m.finalizeSuccess(params.id, 'w', new Date());
    const pgOk = await store.finalizeSuccess(params.id, 'w', new Date());
    expect(pgOk?.status).toBe(memOk?.status);
    expect(pgOk?.status).toBe('succeeded');
  });
});