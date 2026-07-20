/**
 * Jobs module exports (B2-05).
 *
 * End-to-end job status and recovery surface with:
 * - Reload-safe neutral states
 * - Cancel/retry/partial-failure policy via queue leases + quota ledger
 * - Crash and lease-injection recovery
 * - Quota invariant: reserve/commit/release
 * - Tenant isolation on all reads/mutations
 */
export { JobStatusService } from './application/JobStatusService.js';
export type { JobStatusStore } from './application/JobStatusService.js';
export { QueueJobStatusAdapter } from './adapters/QueueJobStatusAdapter.js';
export type { QueueJobStatusAdapterOptions } from './adapters/QueueJobStatusAdapter.js';
export { registerJobRoutes } from './adapters/http/routes.js';
export { toNeutralStatus, toNeutralStage } from './domain/status-mapper.js';
export type {
  NeutralJobStatus,
  JobStatusView,
  JobSubmitInput,
  JobSubmitResult,
  TenantContext,
} from './domain/types.js';
export { NEUTRAL_STATUSES } from './domain/types.js';
export {
  JobNotFoundError,
  JobTenantMismatchError,
  JobNotCancellableError,
} from './domain/errors.js';
