import assert from 'node:assert/strict';

import { fingerprint, safeLogShape } from '../common/redact.js';
import {
  IdempotencyKeyReusedError,
  InMemoryQueueStore,
  QueueSpike,
} from '../infrastructure/queue/index.js';

async function main(): Promise<void> {
  const summary: Record<string, unknown> = {};
  const spike = new QueueSpike(new InMemoryQueueStore(), {
    leaseTtlMs: 1_000,
    leaseSafetyMarginMs: 200,
    maxAttempts: 3,
    backoffBaseMs: 50,
    backoffMaxMs: 1_000,
    workerConcurrency: 2,
    perWorkspaceConcurrency: 1,
    perWorkspaceRateLimit: 2,
    depthAlertThreshold: 1,
  });

  try {
    const submitted = await spike.submit({
      workspaceId: 'smoke-w1',
      actorId: 'smoke-u1',
      operation: 'assessment_generation',
      idempotencyKey: 'SMOKE-IDEMPOTENCY-KEY',
      fingerprint: { request: 'smoke request' },
      quotaUnits: 1,
    });
    summary.submitted = { jobId: submitted.jobId, duplicate: submitted.duplicate };

    const duplicate = await spike.submit({
      workspaceId: 'smoke-w1',
      actorId: 'smoke-u1',
      operation: 'assessment_generation',
      idempotencyKey: 'SMOKE-IDEMPOTENCY-KEY',
      fingerprint: { request: 'smoke request' },
      quotaUnits: 1,
    });
    assert.equal(duplicate.jobId, submitted.jobId);
    assert.equal(duplicate.duplicate, true);
    summary.duplicate = { jobId: duplicate.jobId, duplicate: duplicate.duplicate };

    let reused = false;
    try {
      await spike.submit({
        workspaceId: 'smoke-w1',
        actorId: 'smoke-u1',
        operation: 'assessment_generation',
        idempotencyKey: 'SMOKE-IDEMPOTENCY-KEY',
        fingerprint: { request: 'different request' },
        quotaUnits: 1,
      });
    } catch (err) {
      reused = err instanceof IdempotencyKeyReusedError;
    }
    assert.equal(reused, true);
    summary.idempotencyKeyReused = reused;

    await spike
      .workOnce('smoke-worker-a', { crashAt: 'afterProviderBeforeCommit' })
      .catch(() => undefined);
    await spike.reapExpiredLeases(Date.now() + 5_000);
    await spike.workOnce('smoke-worker-b');
    summary.effects = spike.effectCount();

    const crashEffect = spike.effectCount();
    assert.equal(crashEffect, 1);

    const cross = spike.getJobForWorkspace(submitted.jobId, 'smoke-other-workspace');
    assert.equal(cross.status, 404);
    summary.crossTenant = { lookup: 'not-found', jobIdFingerprint: fingerprint(submitted.jobId) };

    const logs = JSON.stringify(spike.logs());
    assert.equal(logs.includes('SMOKE-IDEMPOTENCY-KEY'), false);
    assert.equal(logs.includes('smoke request'), false);
    summary.redaction = {
      idempotencyKeyShape: safeLogShape('SMOKE-IDEMPOTENCY-KEY'),
      payloadFingerprint: fingerprint('smoke request'),
    };

    summary.quota = spike.quotaSummary('smoke-w1');
    summary.localMode = spike.localMode();
    summary.status = 'ok';
  } catch (err) {
    summary.status = 'error';
    summary.error = {
      name: err instanceof Error ? err.name : 'Error',
      message: err instanceof Error ? err.message : 'unknown error',
    };
    process.stderr.write(`${JSON.stringify(summary)}\n`);
    process.exit(1);
  }

  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

await main();
