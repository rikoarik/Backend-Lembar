import { describe, expect, it } from 'vitest';

import {
  InMemoryQueueStore,
  QueueSpike,
  type WorkerCrashPoint,
} from '../../../src/infrastructure/queue/index.js';

function createSpike(): QueueSpike {
  return new QueueSpike(new InMemoryQueueStore(), {
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
}

async function runCrash(crashAt: WorkerCrashPoint): Promise<QueueSpike> {
  const spike = createSpike();
  await spike.submit({
    workspaceId: 'w1',
    actorId: 'u1',
    operation: 'assessment_generation',
    idempotencyKey: 'K1',
    fingerprint: { prompt: 'secret source text' },
    quotaUnits: 1,
  });
  await expect(spike.workOnce('worker-a', { crashAt })).rejects.toThrow('simulated crash');
  await spike.reapExpiredLeases(121);
  await spike.workOnce('worker-b');
  expect(spike.effectCount()).toBe(1);
  expect(spike.quotaBalance('w1')).toBe(-1);
  return spike;
}

describe('queue and idempotency spike', () => {
  it('proves created -> queued -> running -> succeeded', async () => {
    const spike = createSpike();
    const submitted = await spike.submit({
      workspaceId: 'w1',
      actorId: 'u1',
      operation: 'assessment_generation',
      idempotencyKey: 'K1',
      fingerprint: { request: 1 },
      quotaUnits: 1,
    });

    expect(spike.statusTrail(submitted.jobId)).toEqual(['created', 'queued']);
    await spike.workOnce('worker-a');

    expect(spike.statusTrail(submitted.jobId)).toEqual([
      'created',
      'queued',
      'running',
      'succeeded',
    ]);
  });

  it('retries safely after a worker crash before the provider call', async () => {
    await runCrash('beforeProvider');
  });

  it('retries safely after a worker crash after the provider call before commit', async () => {
    await runCrash('afterProviderBeforeCommit');
  });

  it('returns the original job for duplicate submit and rejects key reuse with another fingerprint', async () => {
    const spike = createSpike();
    const first = await spike.submit({
      workspaceId: 'w1',
      actorId: 'u1',
      operation: 'assessment_generation',
      idempotencyKey: 'K1',
      fingerprint: { request: 1 },
      quotaUnits: 1,
    });
    const second = await spike.submit({
      workspaceId: 'w1',
      actorId: 'u1',
      operation: 'assessment_generation',
      idempotencyKey: 'K1',
      fingerprint: { request: 1 },
      quotaUnits: 1,
    });
    expect(second).toEqual({ ...first, duplicate: true });

    await expect(
      spike.submit({
        workspaceId: 'w1',
        actorId: 'u1',
        operation: 'assessment_generation',
        idempotencyKey: 'K1',
        fingerprint: { request: 2 },
        quotaUnits: 1,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('lets another worker reclaim an expired lease without double effect', async () => {
    const spike = createSpike();
    await spike.submit({
      workspaceId: 'w1',
      actorId: 'u1',
      operation: 'assessment_generation',
      idempotencyKey: 'K1',
      fingerprint: { request: 1 },
      quotaUnits: 1,
    });

    const claimed = await spike.claim('worker-a');
    expect(claimed?.status).toBe('running');
    expect(await spike.claim('worker-b')).toBeNull();
    await spike.reapExpiredLeases(121);
    const reclaimed = await spike.claim('worker-b');
    expect(reclaimed?.attempt).toBe(2);
    await spike.completeClaim(reclaimed!.id, 'worker-b');

    expect(spike.effectCount()).toBe(1);
  });

  it('keeps a heartbeat lease alive and reaps it only after a missed heartbeat plus safety margin', async () => {
    const spike = createSpike();
    await spike.submit({
      workspaceId: 'w1',
      actorId: 'u1',
      operation: 'assessment_generation',
      idempotencyKey: 'K1',
      fingerprint: { request: 1 },
      quotaUnits: 1,
    });
    const claimed = await spike.claim('worker-a');

    await spike.heartbeat(claimed!.id, 'worker-a', 90);
    expect(await spike.reapExpiredLeases(121)).toBe(0);
    expect(await spike.reapExpiredLeases(211)).toBe(1);
  });

  it('enforces workspace concurrency, rate limit, worker concurrency, and emits queue-depth alert', async () => {
    const spike = createSpike();
    for (const idempotencyKey of ['K1', 'K2', 'K3']) {
      await spike.submit({
        workspaceId: 'w1',
        actorId: 'u1',
        operation: 'assessment_generation',
        idempotencyKey,
        fingerprint: { idempotencyKey },
        quotaUnits: 1,
      });
    }

    const first = await spike.claim('worker-a');
    const secondSameWorkspace = await spike.claim('worker-b');

    expect(first).not.toBeNull();
    expect(secondSameWorkspace).toBeNull();
    expect(spike.backpressure()).toMatchObject({
      workerConcurrency: 2,
      perWorkspaceConcurrency: 1,
      perWorkspaceRateLimit: 2,
      queueDepth: 2,
      depthAlert: true,
    });
  });

  it('reserves, commits, and releases quota exactly once across retries', async () => {
    const retried = await runCrash('afterProviderBeforeCommit');
    expect(retried.quotaSummary('w1')).toEqual({
      reserved: 1,
      committed: 1,
      released: 0,
      balance: -1,
    });

    const terminal = createSpike();
    await terminal.submit({
      workspaceId: 'w1',
      actorId: 'u1',
      operation: 'assessment_generation',
      idempotencyKey: 'K1',
      fingerprint: { request: 1 },
      quotaUnits: 1,
    });
    await terminal.failNextJobTerminal('UNSUPPORTED_SOURCE');
    expect(terminal.quotaSummary('w1')).toEqual({
      reserved: 1,
      committed: 0,
      released: 1,
      balance: 0,
    });
  });

  it('uses exponential backoff with jitter and retryable versus terminal failure classification', async () => {
    const spike = createSpike();
    await spike.submit({
      workspaceId: 'w1',
      actorId: 'u1',
      operation: 'assessment_generation',
      idempotencyKey: 'K1',
      fingerprint: { request: 1 },
      quotaUnits: 1,
    });

    const retry = await spike.failNextJobRetryable('PROVIDER_TIMEOUT');
    expect(retry).toMatchObject({ retryable: true, status: 'retry_wait', nextDelayMs: 15 });
    await spike.releaseRetryWait();
    const terminal = await spike.failNextJobTerminal('UNSUPPORTED_SOURCE');
    expect(terminal).toMatchObject({ retryable: false, status: 'failed' });
  });

  it('dead-letters after retry cap and recovers only through an audited command', async () => {
    const spike = createSpike();
    await spike.submit({
      workspaceId: 'w1',
      actorId: 'u1',
      operation: 'assessment_generation',
      idempotencyKey: 'K1',
      fingerprint: { request: 1 },
      quotaUnits: 1,
    });

    for (let i = 0; i < 3; i += 1) {
      await spike.failNextJobRetryable('PROVIDER_TIMEOUT');
      await spike.releaseRetryWait();
    }
    expect(spike.deadLetters()).toHaveLength(1);

    const recovered = await spike.manualRecover(
      spike.deadLetters()[0]!.id,
      'ops-1',
      'retry after provider outage',
    );
    expect(recovered.status).toBe('queued');
    expect(spike.auditTrail()).toContainEqual(
      expect.objectContaining({ action: 'manual_recover', actorId: 'ops-1' }),
    );
  });

  it('cancels between safe stages and releases quota', async () => {
    const spike = createSpike();
    const submitted = await spike.submit({
      workspaceId: 'w1',
      actorId: 'u1',
      operation: 'assessment_generation',
      idempotencyKey: 'K1',
      fingerprint: { request: 1 },
      quotaUnits: 1,
    });

    await spike.requestCancel(submitted.jobId, 'u1');
    await spike.workOnce('worker-a');

    expect(spike.job(submitted.jobId)?.status).toBe('cancelled');
    expect(spike.quotaBalance('w1')).toBe(0);
  });

  it('returns not-found for cross-tenant job ID lookups', async () => {
    const spike = createSpike();
    const submitted = await spike.submit({
      workspaceId: 'w1',
      actorId: 'u1',
      operation: 'assessment_generation',
      idempotencyKey: 'K1',
      fingerprint: { request: 1 },
      quotaUnits: 1,
    });

    expect(spike.getJobForWorkspace(submitted.jobId, 'w2')).toEqual({ status: 404 });
    expect(spike.getJobForWorkspace(submitted.jobId, 'w1')).toMatchObject({ status: 200 });
  });

  it('redacts queue payloads and worker logs', async () => {
    const spike = createSpike();
    await spike.submit({
      workspaceId: 'w1',
      actorId: 'u1',
      operation: 'assessment_generation',
      idempotencyKey: 'SECRET-IDEMPOTENCY-KEY',
      fingerprint: { prompt: 'raw source content', signedUrl: 'https://signed.example/token' },
      quotaUnits: 1,
    });
    await spike.workOnce('worker-a');

    const logs = JSON.stringify(spike.logs());
    expect(logs).not.toContain('SECRET-IDEMPOTENCY-KEY');
    expect(logs).not.toContain('raw source content');
    expect(logs).not.toContain('https://signed.example/token');
    expect(logs).toContain('[redacted]');
  });

  it('runs locally without production Redis or production database', async () => {
    const spike = createSpike();
    expect(spike.localMode()).toEqual({
      queue: 'custom-postgres-only',
      productionStoreRequired: false,
    });
  });
});
