/**
 * Quota reservation domain errors.
 */
export class ReservationNotFoundError extends Error {
  constructor(reservationId: string) {
    super(`Reservation not found: ${reservationId}`);
    this.name = 'ReservationNotFoundError';
  }
}

export class ReservationAlreadyCommittedError extends Error {
  constructor(reservationId: string) {
    super(`Reservation already committed: ${reservationId}`);
    this.name = 'ReservationAlreadyCommittedError';
  }
}

export class ReservationAlreadyReleasedError extends Error {
  constructor(reservationId: string) {
    super(`Reservation already released: ${reservationId}`);
    this.name = 'ReservationAlreadyReleasedError';
  }
}

export class DuplicateIdempotencyKeyError extends Error {
  constructor(key: string) {
    super(`Duplicate idempotency key: ${key}`);
    this.name = 'DuplicateIdempotencyKeyError';
  }
}

export class InsufficientQuotaError extends Error {
  constructor(workspaceId: string, requested: number, available: number) {
    super(
      `Insufficient quota for workspace ${workspaceId}: requested ${requested}, available ${available}`,
    );
    this.name = 'InsufficientQuotaError';
  }
}

export class TenantMismatchError extends Error {
  constructor(reservationId: string, expected: string, actual: string) {
    super(
      `Tenant mismatch for reservation ${reservationId}: expected ${expected}, got ${actual}`,
    );
    this.name = 'TenantMismatchError';
  }
}
