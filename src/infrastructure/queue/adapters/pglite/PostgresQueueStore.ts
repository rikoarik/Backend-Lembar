import { randomUUID } from 'node:crypto';

import { sql, and, eq, isNull, lt, or } from 'drizzle-orm';

import type { Database } from '../../../database/db.js';
import {
  jobs,
  idempotencyKeys,
  type JobStatus,
  type JobKind,
} from '../../persistence/schema.js';
import type {
  QueueStore,
  QueueStoreClaimed,
  QueueStoreIdempotencyRecord,
  QueueStoreJob,
} from '../queue-store.js';

interface JobRowSnake extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  actor_id: string;
  kind: JobKind;
  status: JobStatus;
  attempt: number;
  max_attempts: number;
  lease_ttl_ms: number;
  lease_expires_at: Date | string | null;
  heartbeat_at: Date | string | null;
  payload: Record<string, unknown>;
  quota_units: number;
  next_attempt_at: Date | string | null;
  last_error: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

function toDate(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

function snakeToJob(row: JobRowSnake): QueueStoreJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    kind: row.kind,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    leaseTtlMs: row.lease_ttl_ms,
    leaseExpiresAt: toDate(row.lease_expires_at),
    heartbeatAt: toDate(row.heartbeat_at),
    payload: row.payload,
    quotaUnits: row.quota_units,
    nextAttemptAt: toDate(row.next_attempt_at),
    lastError: row.last_error,
    createdAt: toDate(row.created_at)!,
    updatedAt: toDate(row.updated_at)!,
  };
}

/**
 * Production-shaped Postgres adapter for the B0-06 queue spike.
 *
 * Drizzle is used only for typed query construction; mutations run via raw
 * `db.execute(sql`UPDATE ... RETURNING`)` so claim transitions stay atomic
 * and `RETURNING` lets us echo the post-state row back to callers without a
 * second round-trip.
 *
 * ponytail: the `QueueStore` contract mixes read-mostly admin calls
 * (`auditEvents`, `requestCancel`, `auditRecover`) with hot-path
 * `nextClaimable`/`reserveClaim`/`finalizeSuccess`. The admin calls fall
 * back to a small in-memory audit ring buffer so we can land the
 * worker↔API bridge today; swap those for SQL once ops tooling needs
 * cross-process visibility.
 */
export class PostgresQueueStore implements QueueStore {
  private readonly adminFallback = new InMemoryAdminQueueStore();

  constructor(private readonly db: Database) {}

  newId(): string {
    return randomUUID();
  }

  /**
   * `QueueSpike` reaches into the store synchronously inside the submit
   * duplicate-path; PostgresQueueStore has no in-process cache so we
   * surface the limitation instead of silently returning null.
   */
  getJobSync(_id: string): QueueStoreJob | null {
    throw new Error(
      'PostgresQueueStore.getJobSync is not supported — call getJob() instead.',
    );
  }

  async insertJob(job: Omit<QueueStoreJob, 'createdAt' | 'updatedAt'>): Promise<QueueStoreJob> {
    const result = await this.db.execute<JobRowSnake>(sql`
      INSERT INTO "spike_jobs" (
        "id", "workspace_id", "actor_id", "kind", "status",
        "attempt", "max_attempts", "lease_ttl_ms", "lease_expires_at",
        "heartbeat_at", "payload", "quota_units", "next_attempt_at",
        "last_error"
      ) VALUES (
        ${job.id}::uuid,
        ${job.workspaceId},
        ${job.actorId},
        ${job.kind},
        ${job.status},
        ${job.attempt},
        ${job.maxAttempts},
        ${job.leaseTtlMs},
        ${job.leaseExpiresAt},
        ${job.heartbeatAt},
        ${job.payload as object},
        ${job.quotaUnits},
        ${job.nextAttemptAt},
        ${job.lastError as object}
      )
      RETURNING *`);
    const row = result.rows[0];
    if (!row) throw new Error('insertJob: no row returned');
    return snakeToJob(row);
  }

  async getJob(id: string): Promise<QueueStoreJob | null> {
    const result = await this.db.execute<JobRowSnake>(sql`
      SELECT * FROM "spike_jobs" WHERE "id" = ${id}::uuid LIMIT 1`);
    const row = result.rows[0];
    return row ? snakeToJob(row) : null;
  }

  async getIdempotency(scope: {
    workspaceId: string;
    operation: string;
    key: string;
  }): Promise<QueueStoreIdempotencyRecord | null> {
    const result = await this.db.execute<{
      key: string;
      workspace_id: string;
      operation: string;
      job_id: string;
      fingerprint: string;
    }>(sql`
      SELECT * FROM "spike_idempotency_keys"
       WHERE "workspace_id" = ${scope.workspaceId}
         AND "operation" = ${scope.operation}
         AND "key" = ${scope.key}
       LIMIT 1`);
    const row = result.rows[0];
    if (!row) return null;
    return {
      key: row.key,
      workspaceId: row.workspace_id,
      operation: row.operation,
      jobId: row.job_id,
      fingerprint: row.fingerprint,
    };
  }

  async insertIdempotency(record: QueueStoreIdempotencyRecord): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO "spike_idempotency_keys" ("key", "workspace_id", "operation", "job_id", "fingerprint")
      VALUES (${record.key}, ${record.workspaceId}, ${record.operation}, ${record.jobId}::uuid, ${record.fingerprint})
      ON CONFLICT ("workspace_id", "operation", "key") DO NOTHING`);
  }

  async nextClaimable(
    now: Date,
    excludeWorkspaceIds: string[] = [],
  ): Promise<QueueStoreJob | null> {
    const excludeClause = excludeWorkspaceIds.length === 0
      ? sql``
      : sql`AND ${jobs.workspaceId} NOT IN (${sql.join(
          excludeWorkspaceIds.map((id) => sql`${id}`),
          sql`, `,
        )})`;
    const result = await this.db.execute<JobRowSnake>(sql`
      SELECT * FROM ${jobs}
       WHERE ${jobs.status} IN ('queued', 'retry_wait')
         AND (${jobs.nextAttemptAt} IS NULL OR ${jobs.nextAttemptAt} <= ${now})
         ${excludeClause}
       ORDER BY ${jobs.createdAt} ASC
       LIMIT 1`);
    const row = result.rows[0];
    return row ? snakeToJob(row) : null;
  }

  async reserveClaim(
    id: string,
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<QueueStoreClaimed | null> {
    // workerId is recorded on heartbeat rows, not on the job itself.
    void workerId;
    const expires = new Date(now.getTime() + leaseMs);
    const result = await this.db.execute<JobRowSnake>(sql`
      UPDATE "spike_jobs"
         SET "status"           = 'running',
             "attempt"          = "attempt" + 1,
             "lease_expires_at" = ${expires},
             "heartbeat_at"     = ${now},
             "next_attempt_at"  = NULL,
             "updated_at"       = ${now}
       WHERE "id" = ${id}::uuid
         AND "status" IN ('queued', 'retry_wait')
         AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= ${now})
       RETURNING *`);
    const row = result.rows[0];
    return row ? (snakeToJob(row) as QueueStoreClaimed) : null;
  }

  async releaseClaim(id: string, _workerId: string, now: Date): Promise<QueueStoreJob | null> {
    void _workerId;
    const result = await this.db.execute<JobRowSnake>(sql`
      UPDATE "spike_jobs"
         SET "status"           = 'queued',
             "lease_expires_at" = NULL,
             "heartbeat_at"     = NULL,
             "updated_at"       = ${now}
       WHERE "id" = ${id}::uuid
         AND "status" = 'running'
       RETURNING *`);
    const row = result.rows[0];
    return row ? snakeToJob(row) : null;
  }

  async reapExpired(now: Date, safetyMarginMs: number): Promise<string[]> {
    const cutoff = new Date(now.getTime() - safetyMarginMs);
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE "spike_jobs"
         SET "status"           = 'queued',
             "lease_expires_at" = NULL,
             "heartbeat_at"     = NULL,
             "updated_at"       = ${now}
       WHERE "status" = 'running'
         AND "lease_expires_at" IS NOT NULL
         AND "lease_expires_at" <= ${cutoff}
       RETURNING "id"`);
    return result.rows.map((r) => r.id);
  }

  async heartbeat(
    id: string,
    _workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<QueueStoreJob | null> {
    void _workerId;
    const expires = new Date(now.getTime() + leaseMs);
    const result = await this.db.execute<JobRowSnake>(sql`
      UPDATE "spike_jobs"
         SET "lease_expires_at" = ${expires},
             "heartbeat_at"     = ${now},
             "updated_at"       = ${now}
       WHERE "id" = ${id}::uuid
         AND "status" = 'running'
       RETURNING *`);
    const row = result.rows[0];
    return row ? snakeToJob(row) : null;
  }

  async finalizeSuccess(id: string, _workerId: string, now: Date): Promise<QueueStoreJob | null> {
    void _workerId;
    const result = await this.db.execute<JobRowSnake>(sql`
      UPDATE "spike_jobs"
         SET "status"           = 'succeeded',
             "lease_expires_at" = NULL,
             "heartbeat_at"     = NULL,
             "updated_at"       = ${now}
       WHERE "id" = ${id}::uuid
         AND "status" = 'running'
       RETURNING *`);
    const row = result.rows[0];
    return row ? snakeToJob(row) : null;
  }

  async finalizeFailure(
    id: string,
    _workerId: string,
    now: Date,
    error: unknown,
  ): Promise<QueueStoreJob | null> {
    void _workerId;
    const result = await this.db.execute<JobRowSnake>(sql`
      UPDATE "spike_jobs"
         SET "status"           = 'failed',
             "lease_expires_at" = NULL,
             "heartbeat_at"     = NULL,
             "last_error"        = ${error as object},
             "updated_at"        = ${now}
       WHERE "id" = ${id}::uuid
         AND "status" = 'running'
       RETURNING *`);
    const row = result.rows[0];
    return row ? snakeToJob(row) : null;
  }

  async rescheduleRetry(
    id: string,
    _workerId: string,
    now: Date,
    nextAttemptAt: Date,
    attempt: number,
  ): Promise<QueueStoreJob | null> {
    void _workerId;
    const result = await this.db.execute<JobRowSnake>(sql`
      UPDATE "spike_jobs"
         SET "status"           = 'retry_wait',
             "attempt"          = ${attempt},
             "lease_expires_at" = NULL,
             "heartbeat_at"     = NULL,
             "next_attempt_at"  = ${nextAttemptAt},
             "updated_at"       = ${now}
       WHERE "id" = ${id}::uuid
         AND "status" = 'running'
       RETURNING *`);
    const row = result.rows[0];
    return row ? snakeToJob(row) : null;
  }

  async markDeadLetter(
    id: string,
    _workerId: string,
    now: Date,
    error: unknown,
  ): Promise<QueueStoreJob | null> {
    void _workerId;
    const result = await this.db.execute<JobRowSnake>(sql`
      UPDATE "spike_jobs"
         SET "status"           = 'failed',
             "lease_expires_at" = NULL,
             "heartbeat_at"     = NULL,
             "last_error"        = ${error as object},
             "updated_at"        = ${now}
       WHERE "id" = ${id}::uuid
         AND "status" = 'running'
       RETURNING *`);
    const row = result.rows[0];
    return row ? snakeToJob(row) : null;
  }

  async requestCancel(id: string, now: Date): Promise<QueueStoreJob | null> {
    const result = await this.db.execute<JobRowSnake>(sql`
      UPDATE "spike_jobs"
         SET "status"           = 'cancelled',
             "lease_expires_at" = NULL,
             "heartbeat_at"     = NULL,
             "updated_at"       = ${now}
       WHERE "id" = ${id}::uuid
         AND "status" NOT IN ('succeeded', 'failed', 'cancelled')
       RETURNING *`);
    const row = result.rows[0];
    return row ? snakeToJob(row) : null;
  }

  async updateJobProgress(
    id: string,
    progressCurrent: number,
    progressTotal: number,
    now: Date,
  ): Promise<QueueStoreJob | null> {
    const result = await this.db.execute<JobRowSnake>(sql`
      UPDATE "spike_jobs"
         SET "payload"    = "payload" || ${JSON.stringify({ progressCurrent, progressTotal })}::jsonb,
             "updated_at" = ${now}
       WHERE "id" = ${id}::uuid
         AND "status" = 'running'
       RETURNING *`);
    const row = result.rows[0];
    return row ? snakeToJob(row) : null;
  }

  async auditRecover(
    id: string,
    now: Date,
    actorId: string,
    reason: string,
  ): Promise<QueueStoreJob | null> {
    const result = await this.db.execute<JobRowSnake>(sql`
      UPDATE "spike_jobs"
         SET "status"           = 'queued',
             "lease_expires_at" = NULL,
             "heartbeat_at"     = NULL,
             "next_attempt_at"  = ${now},
             "last_error"        = NULL,
             "updated_at"        = ${now}
       WHERE "id" = ${id}::uuid
         AND "status" = 'failed'
       RETURNING *`);
    const row = result.rows[0];
    if (!row) return null;
    this.adminFallback.recordAudit({
      action: 'manual_recover',
      jobId: id,
      actorId,
      at: now,
      reason,
    });
    return snakeToJob(row);
  }

  async queueDepth(now: Date): Promise<number> {
    const result = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.status, 'queued'),
          or(isNull(jobs.nextAttemptAt), lt(jobs.nextAttemptAt, now)),
        ),
      );
    return result.length;
  }

  async auditEvents(): Promise<
    Array<{ action: string; jobId: string; actorId: string; at: Date; reason?: string }>
  > {
    return this.adminFallback.auditEvents();
  }
}

/**
 * Minimal admin/audit fallback so the QueueStore contract stays implementable
 * today while ops tooling does not yet need cross-process audit history.
 */
class InMemoryAdminQueueStore {
  private readonly events: Array<{
    action: string;
    jobId: string;
    actorId: string;
    at: Date;
    reason?: string;
  }> = [];

  recordAudit(event: {
    action: string;
    jobId: string;
    actorId: string;
    at: Date;
    reason?: string;
  }): void {
    this.events.push(event);
  }

  async auditEvents(): Promise<
    Array<{ action: string; jobId: string; actorId: string; at: Date; reason?: string }>
  > {
    return [...this.events];
  }
}