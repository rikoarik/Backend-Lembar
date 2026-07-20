/**
 * Maps internal queue job statuses to neutral API-facing statuses.
 *
 * Internal states (created, queued, running, retry_wait, succeeded,
 * partially_succeeded, failed, cancelled) are implementation details.
 * The API surface exposes neutral stage names that are safe to show
 * in UI and don't leak worker/lease internals.
 */
import type { JobStatus } from '../../../infrastructure/queue/persistence/schema.js';
import type { NeutralJobStatus } from './types.js';

export function toNeutralStatus(internal: JobStatus): NeutralJobStatus {
  switch (internal) {
    case 'created':
    case 'queued':
      return 'queued';
    case 'running':
      return 'generating';
    case 'retry_wait':
      return 'preparing';
    case 'succeeded':
      return 'completed';
    case 'partially_succeeded':
      return 'partially_failed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

export function toNeutralStage(internal: JobStatus, kind: string): string {
  switch (internal) {
    case 'created':
    case 'queued':
      return 'queued';
    case 'running':
      return `${kind}:processing`;
    case 'retry_wait':
      return `${kind}:retry_pending`;
    case 'succeeded':
      return `${kind}:done`;
    case 'partially_succeeded':
      return `${kind}:partial`;
    case 'failed':
      return `${kind}:failed`;
    case 'cancelled':
      return 'cancelled';
  }
}
