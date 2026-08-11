/** Plan domain types. */
import type { PlanType } from '../persistence/schema.js';
import type { PlanCatalogEntry } from '../persistence/catalogRepository.js';

export type EntitlementState = 'active' | 'expired' | 'blocked' | 'free';

export interface WorkspacePlanSummary {
  workspaceId: string;
  plan: PlanType;
  entitlementSource: 'free' | 'paid' | 'trial';
  entitlementState: EntitlementState;
  generationsUsedThisMonth: number;
  monthlyLimit: number | null;
  tokenUsedThisMonth: number;
  tokenMonthlyLimit: number | null;
  billingCycleStartedAt: string;
  catalog: Omit<PlanCatalogEntry, 'active' | 'revision' | 'updatedAt' | 'updatedBy'>;
  trial: {
    eligible: boolean;
    claimed: boolean;
    activeOnThisDevice: boolean;
    startsAt: string | null;
    endsAt: string | null;
    remainingDays: number | null;
  };
}

export interface PlanTransitionInput {
  tenantId: string;
  workspaceId: string;
  newPlan: PlanType;
  actorId: string;
}

export interface QuotaCheckInput {
  tenantId: string;
  workspaceId: string;
  unitsRequested: number;
}
