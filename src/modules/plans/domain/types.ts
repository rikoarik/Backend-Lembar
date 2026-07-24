/**
 * Plan domain types (B6-01).
 */
import type { PlanType } from '../persistence/schema.js';

export interface WorkspacePlanSummary {
  workspaceId: string;
  plan: PlanType;
  generationsUsedThisMonth: number;
  /** null = unlimited (pro plan) */
  monthlyLimit: number | null;
  billingCycleStartedAt: string;
}

export interface PlanTransitionInput {
  tenantId: string;
  workspaceId: string;
  newPlan: PlanType;
  /** Actor performing the transition (admin user id or system) */
  actorId: string;
}

export interface QuotaCheckInput {
  tenantId: string;
  workspaceId: string;
  unitsRequested: number;
}
