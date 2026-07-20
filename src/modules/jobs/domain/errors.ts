/**
 * Job status domain errors.
 */
export class JobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`Job not found: ${jobId}`);
    this.name = 'JobNotFoundError';
  }
}

export class JobTenantMismatchError extends Error {
  constructor(jobId: string, expected: string, actual: string) {
    super(`Tenant mismatch for job ${jobId}: expected ${expected}, got ${actual}`);
    this.name = 'JobTenantMismatchError';
  }
}

export class JobNotCancellableError extends Error {
  constructor(jobId: string, status: string) {
    super(`Job ${jobId} is not cancellable in status: ${status}`);
    this.name = 'JobNotCancellableError';
  }
}
