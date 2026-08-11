import type { Pool } from 'pg';

export type RetryableJobStatus = 'failed' | 'dead_letter';

export function isRetryableJobStatus(value: unknown): value is RetryableJobStatus {
  return value === 'failed' || value === 'dead_letter';
}

/**
 * State-conditional transition: only one concurrent caller can move a job
 * from a terminal retryable state to queued (and increment its attempt).
 */
export async function retryJobAtomically(pool: Pool, id: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE spike_jobs
       SET status = 'queued',
           attempt = attempt + 1,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           next_attempt_at = now(),
           updated_at = now()
     WHERE id = $1
       AND status IN ('failed', 'dead_letter')
     RETURNING id`,
    [id],
  );
  return result.rowCount === 1;
}

/**
 * Locks all matching retryable jobs in one transaction statement before
 * transitioning them. SKIP LOCKED deliberately excludes work another retry
 * request has already claimed, avoiding duplicate attempt increments.
 */
export async function retryJobsBulkAtomically(
  pool: Pool,
  input: { status?: RetryableJobStatus; q?: string },
): Promise<{ retried: number; skipped: number }> {
  const params: unknown[] = [];
  const filters = ["status IN ('failed', 'dead_letter')"];
  if (input.status) {
    params.push(input.status);
    filters.push(`status = $${params.length}`);
  }
  if (input.q) {
    params.push(`%${input.q}%`);
    filters.push(`(id::text ILIKE $${params.length} OR kind ILIKE $${params.length} OR workspace_id ILIKE $${params.length})`);
  }

  const result = await pool.query<{ retried: string; skipped: string }>(
    `WITH locked_jobs AS (
       SELECT id
       FROM spike_jobs
       WHERE ${filters.join(' AND ')}
       FOR UPDATE SKIP LOCKED
     ), retried_jobs AS (
       UPDATE spike_jobs sj
       SET status = 'queued',
           attempt = sj.attempt + 1,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           next_attempt_at = now(),
           updated_at = now()
       FROM locked_jobs
       WHERE sj.id = locked_jobs.id
         AND sj.status IN ('failed', 'dead_letter')
       RETURNING sj.id
     )
     SELECT
       (SELECT count(*)::text FROM retried_jobs) AS retried,
       ((SELECT count(*) FROM locked_jobs) - (SELECT count(*) FROM retried_jobs))::text AS skipped`,
    params,
  );
  return {
    retried: Number(result.rows[0]?.retried ?? 0),
    skipped: Number(result.rows[0]?.skipped ?? 0),
  };
}
