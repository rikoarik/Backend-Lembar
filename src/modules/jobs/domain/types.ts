/**
 * Job status domain types (B2-05).
 *
 * Maps internal queue states to reload-safe neutral API states.
 * The API surface uses neutral stage names that don't expose
 * implementation details like lease timing or worker identity.
 */

export const NEUTRAL_STATUSES = [
  'queued',
  'preparing',
  'generating',
  'validating',
  'rendering',
  'completed',
  'partially_failed',
  'failed',
  'cancelled',
] as const;

export type NeutralJobStatus = (typeof NEUTRAL_STATUSES)[number];

export interface JobStatusView {
  id: string;
  kind: string;
  status: NeutralJobStatus;
  stage: string;
  progressCurrent: number | null;
  progressTotal: number | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobSubmitInput {
  tenantId: string;
  workspaceId: string;
  actorId: string;
  kind: string;
  idempotencyKey: string;
  fingerprint: unknown;
  quotaUnits: number;
}

export interface JobSubmitResult {
  jobId: string;
  status: NeutralJobStatus;
  duplicate: boolean;
  reservationId: string;
}

export interface TenantContext {
  tenantId: string;
  workspaceId: string;
}
