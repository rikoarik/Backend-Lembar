/**
 * Quota reservation domain types.
 */
import type { ReservationState } from '../persistence/schema.js';

export interface ReserveInput {
  tenantId: string;
  workspaceId: string;
  jobId: string;
  idempotencyKey: string;
  units: number;
}

export interface ReservationResult {
  reservationId: string;
  tenantId: string;
  workspaceId: string;
  jobId: string;
  units: number;
  state: ReservationState;
  duplicate: boolean;
}

export interface QuotaBalance {
  tenantId: string;
  workspaceId: string;
  reserved: number;
  committed: number;
  released: number;
  available: number;
}
