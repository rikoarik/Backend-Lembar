/**
 * Quota module exports.
 */
export { QuotaLedger } from './application/QuotaLedger.js';
export { QuotaReservationRepository } from './persistence/repository.js';
export { quotaReservations } from './persistence/schema.js';
export type {
  QuotaReservation,
  NewQuotaReservation,
  ReservationState,
} from './persistence/schema.js';
export type { ReserveInput, ReservationResult, QuotaBalance } from './domain/types.js';
export {
  ReservationNotFoundError,
  ReservationAlreadyCommittedError,
  ReservationAlreadyReleasedError,
  DuplicateIdempotencyKeyError,
  InsufficientQuotaError,
  TenantMismatchError,
} from './domain/errors.js';
