/**
 * WorkspacePlan repository (B6-01).
 *
 * CRUD over workspace_plans with upsert semantics for plan creation.
 */
import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '../../../infrastructure/database/db.js';
import type { PlanType, WorkspacePlan } from './schema.js';
import { workspacePlans } from './schema.js';
import { FREE_MONTHLY_LIMIT } from './schema.js';

export class WorkspacePlanRepository {
  constructor(private readonly db: Database) {}

  /**
   * Find the active plan for a workspace, or auto-create a free plan.
   */
  async findOrCreate(tenantId: string, workspaceId: string): Promise<WorkspacePlan> {
    const existing = await this.db
      .select()
      .from(workspacePlans)
      .where(and(eq(workspacePlans.tenantId, tenantId), eq(workspacePlans.workspaceId, workspaceId)))
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
      .where(and(eq(workspacePlans.tenantId, tenantId), eq(workspacePlans.workspaceId, workspaceId)))
      .limit(1);

    if (!fetched) throw new Error(`Failed to find or create plan for workspace ${workspaceId}`);
    return fetched;
  }

  async findByWorkspace(tenantId: string, workspaceId: string): Promise<WorkspacePlan | null> {
    const [row] = await this.db
      .select()
      .from(workspacePlans)
      .where(and(eq(workspacePlans.tenantId, tenantId), eq(workspacePlans.workspaceId, workspaceId)))
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
    await this.db
      .update(workspacePlans)
      .set({
        generationsUsedThisMonth: 0,
        billingCycleStartedAt: now,
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
      .where(and(eq(workspacePlans.tenantId, tenantId), eq(workspacePlans.workspaceId, workspaceId)))
      .returning();

    if (!updated) throw new Error(`Plan not found for workspace ${workspaceId}`);
    return updated;
  }

  async setPlan(tenantId: string, workspaceId: string, plan: PlanType): Promise<WorkspacePlan> {
    const now = new Date();
    // Upsert: create if not exists, update plan if exists
    await this.findOrCreate(tenantId, workspaceId);

    const [updated] = await this.db
      .update(workspacePlans)
      .set({ plan, updatedAt: now })
      .where(and(eq(workspacePlans.tenantId, tenantId), eq(workspacePlans.workspaceId, workspaceId)))
      .returning();

    if (!updated) throw new Error(`Failed to update plan for workspace ${workspaceId}`);
    return updated;
  }

  /**
   * Check if a workspace has quota available (returns true = allowed).
   * Pro plan: always true. Free plan: true if used < 10.
   */
  async hasQuota(tenantId: string, workspaceId: string): Promise<boolean> {
    const plan = await this.findOrCreate(tenantId, workspaceId);

    // Reset if new billing cycle
    const now = new Date();
    const cycleMonth = plan.billingCycleStartedAt.getMonth();
    const cycleYear = plan.billingCycleStartedAt.getFullYear();
    if (now.getMonth() !== cycleMonth || now.getFullYear() !== cycleYear) {
      return true; // Will reset on next increment
    }

    if (plan.plan === 'pro') return true;
    return plan.generationsUsedThisMonth < FREE_MONTHLY_LIMIT;
  }
}
