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
  trial_claim_links_token_unique: 'TRIAL_CLAIM_LINK_INVALID',
  trial_claim_links_user_unique: 'TRIAL_CLAIM_LINK_INVALID',
  trial_claim_links_workspace_unique: 'TRIAL_CLAIM_LINK_INVALID',
};

type ClaimInput = Parameters<TrialStore['claim']>[0];
type IssueClaimLinkInput = Parameters<TrialStore['issueClaimLink']>[0];

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
      plan: 'free' | 'pro' | 'plus';
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

  async issueClaimLink(input: IssueClaimLinkInput): Promise<void> {
    const client = await this.pool().connect();
    try {
      await client.query('BEGIN');
      await this.lockIdentity(client, input.userId, input.workspaceId);
      const claimed = await client.query(
        `SELECT 1 FROM trial_claims WHERE user_id = $1 OR workspace_id = $2 LIMIT 1`,
        [input.userId, input.workspaceId],
      );
      if (claimed.rowCount) throw new TrialConflictError('TRIAL_ALREADY_CLAIMED');
      await client.query(`DELETE FROM trial_claim_links WHERE user_id = $1 OR workspace_id = $2`, [
        input.userId,
        input.workspaceId,
      ]);
      await client.query(
        `INSERT INTO trial_claim_links
          (user_id, workspace_id, token_hash, expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.userId, input.workspaceId, input.tokenHash, input.expiresAt, input.issuedAt],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      this.rethrowConflict(error);
    } finally {
      client.release();
    }
  }

  async claim(input: ClaimInput) {
    const client = await this.pool().connect();
    try {
      await client.query('BEGIN');
      const link = await client.query<{
        user_id: string;
        workspace_id: string;
        expires_at: Date;
        used_at: Date | null;
      }>(
        `SELECT user_id, workspace_id, expires_at, used_at
           FROM trial_claim_links
          WHERE token_hash = $1
          FOR UPDATE`,
        [input.claimTokenHash],
      );
      const claimLink = link.rows[0];
      if (
        !claimLink ||
        claimLink.user_id !== input.userId ||
        claimLink.workspace_id !== input.workspaceId ||
        claimLink.used_at !== null ||
        claimLink.expires_at <= input.startsAt
      ) {
        throw new TrialConflictError('TRIAL_CLAIM_LINK_INVALID');
      }

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
      await client.query(
        `UPDATE trial_claim_links
            SET used_at = $3
          WHERE user_id = $1 AND workspace_id = $2 AND used_at IS NULL`,
        [input.userId, input.workspaceId, input.startsAt],
      );
      await client.query('COMMIT');
      return { startsAt: result.rows[0]!.starts_at, endsAt: result.rows[0]!.ends_at };
    } catch (error) {
      await client.query('ROLLBACK');
      this.rethrowConflict(error);
    } finally {
      client.release();
    }
  }

  private rethrowConflict(error: unknown): never {
    if (error instanceof TrialConflictError) throw error;
    const constraint = (error as { constraint?: string }).constraint;
    if (constraint && CONFLICT_BY_CONSTRAINT[constraint]) {
      throw new TrialConflictError(CONFLICT_BY_CONSTRAINT[constraint]);
    }
    throw error;
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
