/**
 * Quota reservation ledger application service.
 *
 * Implements the reserve/commit/release lifecycle pattern
 * with concurrency guards, duplicate detection, and balance tracking.
 */
import { QuotaReservationRepository } from '../persistence/repository.js';
import type { QuotaReservation } from '../persistence/schema.js';
import type { ReserveInput, ReservationResult, QuotaBalance } from '../domain/types.js';
import {
  ReservationNotFoundError,
  ReservationAlreadyCommittedError,
  ReservationAlreadyReleasedError,
  DuplicateIdempotencyKeyError,
  TenantMismatchError,
} from '../domain/errors.js';

export class QuotaLedger {
  constructor(private readonly repository: QuotaReservationRepository) {}

  /**
   * Reserve quota units for a job.
   * Idempotent: returns existing reservation if idempotency key matches.
   * Throws DuplicateIdempotencyKeyError if key is reused with different fingerprint.
   */
  async reserve(input: ReserveInput): Promise<ReservationResult> {
    const existing = await this.repository.findByIdempotencyKey(
      input.tenantId,
      input.workspaceId,
      input.idempotencyKey,
    );

    if (existing) {
      if (existing.jobId !== input.jobId) {
        throw new DuplicateIdempotencyKeyError(input.idempotencyKey);
      }
      return {
        reservationId: existing.id,
        tenantId: existing.tenantId,
        workspaceId: existing.workspaceId,
        jobId: existing.jobId,
        units: existing.units,
        state: existing.state,
        duplicate: true,
      };
    }

    const reservation = await this.repository.insert({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      idempotencyKey: input.idempotencyKey,
      units: input.units,
      state: 'reserved',
    });

    return {
      reservationId: reservation.id,
      tenantId: reservation.tenantId,
      workspaceId: reservation.workspaceId,
      jobId: reservation.jobId,
      units: reservation.units,
      state: reservation.state,
      duplicate: false,
    };
  }

  /**
   * Commit a reservation (mark quota as consumed).
   * Idempotent: no-op if already committed.
   */
  async commit(
    reservationId: string,
    tenantId: string,
  ): Promise<QuotaReservation> {
    const reservation = await this.repository.findById(reservationId);
    if (!reservation) {
      throw new ReservationNotFoundError(reservationId);
    }

    if (reservation.tenantId !== tenantId) {
      throw new TenantMismatchError(reservationId, tenantId, reservation.tenantId);
    }

    if (reservation.state === 'committed') {
      return reservation;
    }

    if (reservation.state === 'released') {
      throw new ReservationAlreadyReleasedError(reservationId);
    }

    const committed = await this.repository.commit(reservationId);
    if (!committed) {
      throw new Error('Failed to commit reservation');
    }

    return committed;
  }

  /**
   * Release a reservation (return quota to available pool).
   * Idempotent: no-op if already released.
   */
  async release(
    reservationId: string,
    tenantId: string,
  ): Promise<QuotaReservation> {
    const reservation = await this.repository.findById(reservationId);
    if (!reservation) {
      throw new ReservationNotFoundError(reservationId);
    }

    if (reservation.tenantId !== tenantId) {
      throw new TenantMismatchError(reservationId, tenantId, reservation.tenantId);
    }

    if (reservation.state === 'released') {
      return reservation;
    }

    if (reservation.state === 'committed') {
      throw new ReservationAlreadyCommittedError(reservationId);
    }

    const released = await this.repository.release(reservationId);
    if (!released) {
      throw new Error('Failed to release reservation');
    }

    return released;
  }

  /**
   * Get quota balance for a workspace.
   */
  async getBalance(tenantId: string, workspaceId: string): Promise<QuotaBalance> {
    return this.repository.getBalance(tenantId, workspaceId);
  }

  /**
   * Get reservation by ID.
   */
  async getReservation(reservationId: string): Promise<QuotaReservation | null> {
    return this.repository.findById(reservationId);
  }

  /**
   * Get reservation by job ID.
   */
  async getReservationByJobId(jobId: string): Promise<QuotaReservation | null> {
    return this.repository.findByJobId(jobId);
  }
}

// Re-export types for convenience
export type { QuotaReservation } from '../persistence/schema.js';
export type { ReserveInput, ReservationResult, QuotaBalance } from '../domain/types.js';
