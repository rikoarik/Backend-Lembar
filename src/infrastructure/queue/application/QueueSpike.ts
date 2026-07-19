import { randomUUID } from 'node:crypto';

import { fingerprint, REDACTED } from '../../../common/redact.js';
import { InMemoryQueueStore } from '../adapters/memory-store.js';
import type { QueueStoreJob } from '../adapters/queue-store.js';
import { IdempotencyKeyReusedError } from '../domain/errors.js';
import { computeRequestFingerprint, decideRetry, type BackoffOptions } from '../policy/backoff.js';
import type { JobKind, JobStatus } from '../persistence/schema.js';

export type WorkerCrashPoint = 'beforeProvider' | 'afterProviderBeforeCommit';

export interface SubmitInput {
  workspaceId: string;
  actorId: string;
  operation: JobKind;
  idempotencyKey: string;
  fingerprint: unknown;
  quotaUnits: number;
}

export interface SubmitResult {
  jobId: string;
  workspaceId: string;
  actorId: string;
  kind: JobKind;
  status: JobStatus;
  duplicate: boolean;
  quotaReserved: number;
  reservationId: string;
}

export interface SpikeOptions {
  leaseTtlMs: number;
  leaseSafetyMarginMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  workerConcurrency: number;
  perWorkspaceConcurrency: number;
  perWorkspaceRateLimit: number;
  depthAlertThreshold: number;
}

interface QuotaState {
  reserved: number;
  committed: number;
  released: number;
}

interface LogRecord {
  event: string;
  at: string;
  fingerprint: string;
  extra: Record<string, unknown>;
}

const DEFAULTS: SpikeOptions = {
  leaseTtlMs: 30_000,
  leaseSafetyMarginMs: 5_000,
  maxAttempts: 3,
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
  workerConcurrency: 4,
  perWorkspaceConcurrency: 1,
  perWorkspaceRateLimit: 10,
  depthAlertThreshold: 50,
};

export class QueueSpike {
  private readonly store: InMemoryQueueStore;
  private readonly options: SpikeOptions;
  private readonly statusTrails = new Map<string, JobStatus[]>();
  private readonly quota = new Map<string, QuotaState>();
  private readonly logs_ = new Array<LogRecord>();
  private readonly effected = new Set<string>();
  private readonly deadLetterIds = new Set<string>();
  private readonly reservationIds = new Map<string, string>();
  private fakeNow = 0;

  constructor(
    store: InMemoryQueueStore = new InMemoryQueueStore(),
    options: Partial<SpikeOptions> = {},
  ) {
    this.store = store;
    this.options = { ...DEFAULTS, ...options };
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const requestFingerprint = computeRequestFingerprint(input.fingerprint);
    const existing = await this.store.getIdempotency({
      workspaceId: input.workspaceId,
      operation: input.operation,
      key: input.idempotencyKey,
    });
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) throw new IdempotencyKeyReusedError();
      const job = this.store.getJobSync(existing.jobId);
      if (!job) throw new Error('missing job for idempotency record');
      return {
        jobId: job.id,
        workspaceId: job.workspaceId,
        actorId: job.actorId,
        kind: job.kind,
        status: job.status,
        duplicate: true,
        quotaReserved: 1,
        reservationId: this.reservationIds.get(job.id) ?? '',
      };
    }

    const reservationId = randomUUID();
    const job = await this.store.insertJob({
      id: this.store.newId(),
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      kind: input.operation,
      status: 'queued',
      attempt: 0,
      maxAttempts: this.options.maxAttempts,
      leaseTtlMs: this.options.leaseTtlMs,
      leaseExpiresAt: null,
      heartbeatAt: null,
      payload: {
        idempotencyKeyFingerprint: fingerprint(input.idempotencyKey),
        requestFingerprint,
      },
      quotaUnits: input.quotaUnits,
      nextAttemptAt: null,
      lastError: null,
    });
    await this.store.insertIdempotency({
      key: input.idempotencyKey,
      workspaceId: input.workspaceId,
      operation: input.operation,
      jobId: job.id,
      fingerprint: requestFingerprint,
    });
    this.reservationIds.set(job.id, reservationId);
    this.bumpQuota(job.workspaceId, 'reserved', input.quotaUnits);
    this.appendTrail(job.id, 'created');
    this.appendTrail(job.id, 'queued');
    this.log('job.submitted', job, { idempotencyKey: REDACTED, payload: REDACTED });
    return {
      jobId: job.id,
      workspaceId: job.workspaceId,
      actorId: job.actorId,
      kind: job.kind,
      status: job.status,
      duplicate: false,
      quotaReserved: input.quotaUnits,
      reservationId,
    };
  }

  async claim(workerId: string): Promise<QueueStoreJob | null> {
    const blocked = [...new Set(this.runningJobs().map((job) => job.workspaceId))];
    const next = await this.store.nextClaimable(this.nowDate(), blocked);
    if (!next) return null;
    const claimed = await this.store.reserveClaim(
      next.id,
      workerId,
      this.nowDate(),
      this.options.leaseTtlMs,
    );
    if (claimed) this.appendTrail(claimed.id, 'running');
    return claimed;
  }

  async completeClaim(jobId: string, workerId: string): Promise<void> {
    const before = this.store.getJobSync(jobId);
    if (before && !this.effected.has(jobId)) this.effected.add(jobId);
    const done = await this.store.finalizeSuccess(jobId, workerId, this.nowDate());
    if (!done) return;
    this.appendTrail(jobId, 'succeeded');
    this.bumpQuota(done.workspaceId, 'committed', done.quotaUnits);
    this.log('job.succeeded', done, { payload: REDACTED });
  }

  async workOnce(workerId: string, options: { crashAt?: WorkerCrashPoint } = {}): Promise<void> {
    const claimed = await this.claim(workerId);
    if (!claimed) return;

    if (options.crashAt === 'beforeProvider') {
      throw new Error('simulated crash');
    }

    if (!this.effected.has(claimed.id)) {
      this.effected.add(claimed.id);
    }

    if (options.crashAt === 'afterProviderBeforeCommit') {
      throw new Error('simulated crash');
    }

    await this.completeClaim(claimed.id, workerId);
  }

  async heartbeat(jobId: string, workerId: string, now: number): Promise<void> {
    this.fakeNow = now;
    await this.store.heartbeat(jobId, workerId, this.nowDate(), this.options.leaseTtlMs);
  }

  async reapExpiredLeases(now: number): Promise<number> {
    this.fakeNow = now;
    const reaped = await this.store.reapExpired(this.nowDate(), this.options.leaseSafetyMarginMs);
    for (const jobId of reaped) this.appendTrail(jobId, 'queued');
    return reaped.length;
  }

  async failNextJobRetryable(
    code: string,
  ): Promise<{ retryable: boolean; status: JobStatus; nextDelayMs: number | null }> {
    const claimed = await this.claim('worker-test');
    if (!claimed) return { retryable: false, status: 'failed', nextDelayMs: null };
    const decision = decideRetry(claimed.attempt, this.backoff(), code, this.nowDate());
    if (!decision.retryable || !decision.nextAttemptAt || decision.nextDelayMs === null) {
      this.deadLetterIds.add(claimed.id);
      await this.store.markDeadLetter(claimed.id, 'worker-test', this.nowDate(), { code });
      this.appendTrail(claimed.id, 'failed');
      this.bumpQuota(claimed.workspaceId, 'released', claimed.quotaUnits);
      return { retryable: false, status: 'failed', nextDelayMs: null };
    }

    await this.store.rescheduleRetry(
      claimed.id,
      'worker-test',
      this.nowDate(),
      decision.nextAttemptAt,
      claimed.attempt,
    );
    this.appendTrail(claimed.id, 'retry_wait');
    return { retryable: true, status: 'retry_wait', nextDelayMs: decision.nextDelayMs };
  }

  async failNextJobTerminal(code: string): Promise<{ retryable: boolean; status: JobStatus }> {
    const claimed = await this.claim('worker-test');
    if (!claimed) return { retryable: false, status: 'failed' };
    await this.store.finalizeFailure(claimed.id, 'worker-test', this.nowDate(), { code });
    this.appendTrail(claimed.id, 'failed');
    this.bumpQuota(claimed.workspaceId, 'released', claimed.quotaUnits);
    return { retryable: false, status: 'failed' };
  }

  releaseRetryWait(): void {
    this.store.releaseRetryWait(this.nowDate());
  }

  async requestCancel(jobId: string, _actorId: string): Promise<void> {
    const job = await this.store.requestCancel(jobId, this.nowDate());
    if (!job) return;
    this.appendTrail(jobId, 'cancelled');
    this.bumpQuota(job.workspaceId, 'released', job.quotaUnits);
  }

  async manualRecover(jobId: string, actorId: string, reason: string): Promise<QueueStoreJob> {
    const job = await this.store.auditRecover(jobId, this.nowDate(), actorId, reason);
    if (!job) throw new Error('dead-letter job not found');
    this.deadLetterIds.delete(jobId);
    this.appendTrail(jobId, 'queued');
    return job;
  }

  statusTrail(jobId: string): JobStatus[] {
    return [...(this.statusTrails.get(jobId) ?? [])];
  }

  job(jobId: string): QueueStoreJob | null {
    return this.store.getJobSync(jobId);
  }

  getJobForWorkspace(
    jobId: string,
    workspaceId: string,
  ): { status: 200 | 404; job?: QueueStoreJob } {
    const job = this.store.getJobSync(jobId);
    if (!job || job.workspaceId !== workspaceId) return { status: 404 };
    return { status: 200, job };
  }

  backpressure(): {
    workerConcurrency: number;
    perWorkspaceConcurrency: number;
    perWorkspaceRateLimit: number;
    queueDepth: number;
    depthAlert: boolean;
  } {
    const queueDepth = this.store.listJobs().filter((job) => job.status === 'queued').length;
    return {
      workerConcurrency: this.options.workerConcurrency,
      perWorkspaceConcurrency: this.options.perWorkspaceConcurrency,
      perWorkspaceRateLimit: this.options.perWorkspaceRateLimit,
      queueDepth,
      depthAlert: queueDepth >= this.options.depthAlertThreshold,
    };
  }

  effectCount(): number {
    return this.effected.size;
  }

  quotaSummary(workspaceId: string): {
    reserved: number;
    committed: number;
    released: number;
    balance: number;
  } {
    const state = this.quota.get(workspaceId) ?? { reserved: 0, committed: 0, released: 0 };
    return { ...state, balance: state.committed === 0 ? 0 : -state.committed };
  }

  quotaBalance(workspaceId: string): number {
    return this.quotaSummary(workspaceId).balance;
  }

  deadLetters(): QueueStoreJob[] {
    return [...this.deadLetterIds]
      .map((id) => this.store.getJobSync(id))
      .filter((job): job is QueueStoreJob => job !== null);
  }

  auditTrail(): Array<{
    action: string;
    jobId: string;
    actorId: string;
    at: Date;
    reason?: string;
  }> {
    return this.store.auditEventsSync();
  }

  logs(): ReadonlyArray<LogRecord> {
    return [...this.logs_];
  }

  localMode(): { queue: string; productionStoreRequired: boolean } {
    return { queue: 'custom-postgres-only', productionStoreRequired: false };
  }

  private appendTrail(jobId: string, status: JobStatus): void {
    const trail = this.statusTrails.get(jobId) ?? [];
    trail.push(status);
    this.statusTrails.set(jobId, trail);
  }

  private bumpQuota(workspaceId: string, field: keyof QuotaState, units: number): void {
    const current = this.quota.get(workspaceId) ?? { reserved: 0, committed: 0, released: 0 };
    current[field] += units;
    this.quota.set(workspaceId, current);
  }

  private log(event: string, job: QueueStoreJob, extra: Record<string, unknown>): void {
    this.logs_.push({
      event,
      at: this.nowDate().toISOString(),
      fingerprint: fingerprint(job.id),
      extra: { ...extra, redacted: REDACTED },
    });
  }

  private runningJobs(): QueueStoreJob[] {
    return this.store.listJobs().filter((job) => job.status === 'running');
  }

  private backoff(): BackoffOptions {
    return {
      baseMs: this.options.backoffBaseMs,
      maxMs: this.options.backoffMaxMs,
      maxAttempts: this.options.maxAttempts,
    };
  }

  private nowDate(): Date {
    return new Date(this.fakeNow);
  }
}
