import type { PoolClient } from 'pg';
import { getPool, type Database } from '../../../infrastructure/database/db.js';
import type { EligibleTrialProfile, TrialStore } from '../application/TrialService.js';

export class TrialConflictError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

const CONFLICT_BY_CONSTRAINT: Record<string, string> = {
  trial_claims_user_unique: 'TRIAL_ALREADY_CLAIMED',
  trial_claims_email_hash_unique: 'TRIAL_IDENTITY_ALREADY_USED',
  trial_claims_phone_hash_unique: 'TRIAL_IDENTITY_ALREADY_USED',
  trial_claims_workspace_unique: 'TRIAL_ALREADY_CLAIMED',
  trial_claims_device_unique: 'TRIAL_DEVICE_ALREADY_USED',
};

type ClaimInput = Parameters<TrialStore['claim']>[0];

export class TrialRepository implements TrialStore {
  constructor(private readonly db: Database) {}

  async findByWorkspace(workspaceId: string) {
    const result = await this.pool().query<{
      starts_at: Date;
      ends_at: Date;
      device_hash: string;
    }>('SELECT starts_at, ends_at, device_hash FROM trial_claims WHERE workspace_id = $1', [
      workspaceId,
    ]);
    const row = result.rows[0];
    return row
      ? { startsAt: row.starts_at, endsAt: row.ends_at, deviceHash: row.device_hash }
      : null;
  }

  async getEligibleProfile(userId: string, workspaceId: string): Promise<EligibleTrialProfile> {
    const result = await this.pool().query<{
      email: string;
      phone: string | null;
      plan: 'free' | 'pro';
    }>(
      `SELECT u.email, u.phone, COALESCE(p.plan, 'free') AS plan
         FROM jwt_users u
         LEFT JOIN workspace_plans p
           ON p.tenant_id = u.workspace_id AND p.workspace_id = u.workspace_id::text
        WHERE u.id = $1 AND u.workspace_id = $2 AND u.deleted_at IS NULL`,
      [userId, workspaceId],
    );
    const row = result.rows[0];
    if (!row) throw new TrialConflictError('TRIAL_NOT_ELIGIBLE');
    return { email: row.email, phone: row.phone ?? '', plan: row.plan };
  }

  async claim(input: ClaimInput) {
    const client = await this.pool().connect();
    try {
      await client.query('BEGIN');
      await this.lockIdentity(client, input.userId, input.workspaceId);
      const result = await client.query<{ starts_at: Date; ends_at: Date }>(
        `INSERT INTO trial_claims
          (user_id, workspace_id, email_hash, phone_hash, device_hash, ip_hash, starts_at, ends_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING starts_at, ends_at`,
        [
          input.userId,
          input.workspaceId,
          input.emailHash,
          input.phoneHash,
          input.deviceHash,
          input.ipHash,
          input.startsAt,
          input.endsAt,
        ],
      );
      await client.query('COMMIT');
      return { startsAt: result.rows[0]!.starts_at, endsAt: result.rows[0]!.ends_at };
    } catch (error) {
      await client.query('ROLLBACK');
      const constraint = (error as { constraint?: string }).constraint;
      if (constraint && CONFLICT_BY_CONSTRAINT[constraint]) {
        throw new TrialConflictError(CONFLICT_BY_CONSTRAINT[constraint]);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockIdentity(client: PoolClient, userId: string, workspaceId: string) {
    const result = await client.query<{ plan: string }>(
      `SELECT COALESCE(p.plan, 'free') AS plan FROM jwt_users u
       LEFT JOIN workspace_plans p ON p.tenant_id=u.workspace_id AND p.workspace_id=u.workspace_id::text
       WHERE u.id=$1 AND u.workspace_id=$2 AND u.deleted_at IS NULL FOR UPDATE OF u`,
      [userId, workspaceId],
    );
    if (!result.rows[0]) throw new TrialConflictError('TRIAL_NOT_ELIGIBLE');
    if (result.rows[0].plan !== 'free') throw new TrialConflictError('TRIAL_NOT_ELIGIBLE');
  }

  private pool() {
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database pool unavailable');
    return pool;
  }
}
