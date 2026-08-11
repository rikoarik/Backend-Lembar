/**
 * WorkspacePlan repository (B6-01).
 *
 * CRUD over workspace_plans with upsert semantics for plan creation.
 */
import { and, eq, sql } from 'drizzle-orm';

import { getPool, type Database } from '../../../infrastructure/database/db.js';
import type { PlanType, WorkspacePlan } from './schema.js';
import { workspacePlans } from './schema.js';
import { FREE_MONTHLY_TOKEN_LIMIT } from './schema.js';

export class WorkspacePlanRepository {
  constructor(private readonly db: Database) {}

  /** Bind this repository to an existing Drizzle transaction. */
  withDatabase(db: Database): WorkspacePlanRepository {
    return new WorkspacePlanRepository(db);
  }

  /**
   * Find the active plan for a workspace, or auto-create a free plan.
   * Returns a default free plan if DB query fails (e.g., demo workspaces).
   */
  async findOrCreate(tenantId: string, workspaceId: string): Promise<WorkspacePlan> {
      const existing = await this.db
        .select()
        .from(workspacePlans)
        .where(
          and(eq(workspacePlans.tenantId, tenantId), eq(workspacePlans.workspaceId, workspaceId)),
        )
        .limit(1);

      if (existing[0]) return existing[0];

      const [created] = await this.db
        .insert(workspacePlans)
        .values({ tenantId, workspaceId, plan: 'free' })
        .onConflictDoNothing()
        .returning();

      if (created) return created;

      // Race condition: another process inserted — fetch again
      const [fetched] = await this.db
        .select()
        .from(workspacePlans)
        .where(
          and(eq(workspacePlans.tenantId, tenantId), eq(workspacePlans.workspaceId, workspaceId)),
        )
        .limit(1);

      if (!fetched) throw new Error(`Failed to find or create plan for workspace ${workspaceId}`);
      return fetched;

  }

  async findByWorkspace(tenantId: string, workspaceId: string): Promise<WorkspacePlan | null> {
    const [row] = await this.db
      .select()
      .from(workspacePlans)
      .where(
        and(eq(workspacePlans.tenantId, tenantId), eq(workspacePlans.workspaceId, workspaceId)),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Atomically increment usage counter and return new count.
   * Resets if billing cycle has rolled over (new calendar month).
   */
  async incrementUsage(tenantId: string, workspaceId: string): Promise<WorkspacePlan> {
    const now = new Date();

    // Reset counter if billing cycle has rolled over (new calendar month)
    // For free plans, billingCycleStartedAt resets to the 1st of the current month
    await this.db
      .update(workspacePlans)
      .set({
        generationsUsedThisMonth: 0,
        billingCycleStartedAt: sql`date_trunc('month', now())`,
        updatedAt: now,
      })
      .where(
        and(
          eq(workspacePlans.tenantId, tenantId),
          eq(workspacePlans.workspaceId, workspaceId),
          // Cycle started in a previous calendar month
          sql`date_trunc('month', ${workspacePlans.billingCycleStartedAt}) < date_trunc('month', now())`,
        ),
      );

    const [updated] = await this.db
      .update(workspacePlans)
      .set({
        generationsUsedThisMonth: sql`${workspacePlans.generationsUsedThisMonth} + 1`,
        updatedAt: now,
      })
      .where(
        and(eq(workspacePlans.tenantId, tenantId), eq(workspacePlans.workspaceId, workspaceId)),
      )
      .returning();

    if (!updated) throw new Error(`Plan not found for workspace ${workspaceId}`);
    return updated;
  }

  async incrementUsageOnce(
    tenantId: string,
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<void> {
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database pool unavailable');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO plan_generation_usage (tenant_id, workspace_id, idempotency_key)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1`,
        [tenantId, workspaceId, idempotencyKey],
      );
      if (inserted.rowCount) {
        await client.query(
          `UPDATE workspace_plans SET generations_used_this_month=generations_used_this_month+1, updated_at=now()
           WHERE tenant_id=$1 AND workspace_id=$2`,
          [tenantId, workspaceId],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async setPlan(tenantId: string, workspaceId: string, plan: PlanType): Promise<WorkspacePlan> {
    const now = new Date();
    // Upsert: create if not exists, update plan if exists
    await this.findOrCreate(tenantId, workspaceId);

    const [updated] = await this.db
      .update(workspacePlans)
      .set({ plan, updatedAt: now })
      .where(
        and(eq(workspacePlans.tenantId, tenantId), eq(workspacePlans.workspaceId, workspaceId)),
      )
      .returning();

    if (!updated) throw new Error(`Failed to update plan for workspace ${workspaceId}`);
    return updated;
  }

  /**
   * Check if a workspace has quota available (returns true = allowed).
   * Pro plan: always true. Free plan: true if used < 10.
   */
  async hasQuota(tenantId: string, workspaceId: string): Promise<boolean> {
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database pool unavailable');
    const result = await pool.query<{ plan: PlanType; tokens_used_this_month: string; token_monthly_limit: string | null }>(
      `UPDATE workspace_plans SET
         tokens_used_this_month=CASE WHEN date_trunc('month',billing_cycle_started_at)<date_trunc('month',now()) THEN 0 ELSE tokens_used_this_month END,
         billing_cycle_started_at=CASE WHEN date_trunc('month',billing_cycle_started_at)<date_trunc('month',now()) THEN date_trunc('month',now()) ELSE billing_cycle_started_at END
       WHERE tenant_id=$1 AND workspace_id=$2
       RETURNING plan,tokens_used_this_month,token_monthly_limit`, [tenantId, workspaceId]);
    const row = result.rows[0];
    if (!row) throw new Error(`Plan not found for workspace ${workspaceId}`);
    return row.plan === 'pro' || Number(row.tokens_used_this_month) < Number(row.token_monthly_limit ?? FREE_MONTHLY_TOKEN_LIMIT);
  }

  async recordTokenUsage(tenantId: string, workspaceId: string, providerCallId: string, tokens: number, source: 'actual' | 'estimated'): Promise<void> {
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database pool unavailable');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(`INSERT INTO ai_token_usage_ledger (tenant_id,workspace_id,provider_call_id,tokens,usage_source) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING 1`, [tenantId, workspaceId, providerCallId, tokens, source]);
      if (inserted.rowCount) {
        const updated = await client.query(`UPDATE workspace_plans SET tokens_used_this_month=CASE WHEN date_trunc('month',billing_cycle_started_at)<date_trunc('month',now()) THEN $3 ELSE tokens_used_this_month+$3 END,billing_cycle_started_at=CASE WHEN date_trunc('month',billing_cycle_started_at)<date_trunc('month',now()) THEN date_trunc('month',now()) ELSE billing_cycle_started_at END,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2`, [tenantId, workspaceId, tokens]);
        if (!updated.rowCount) throw new Error(`Plan not found for workspace ${workspaceId}`);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
}
