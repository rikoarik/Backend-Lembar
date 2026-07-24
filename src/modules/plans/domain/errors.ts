/**
 * Plan domain errors (B6-01).
 */

export class QuotaExceededError extends Error {
  readonly workspaceId: string;
  readonly used: number;
  readonly limit: number;

  constructor(workspaceId: string, used: number, limit: number) {
    super(
      `Workspace ${workspaceId} has exceeded monthly generation quota (used: ${used}, limit: ${limit})`,
    );
    this.name = 'QuotaExceededError';
    this.workspaceId = workspaceId;
    this.used = used;
    this.limit = limit;
  }
}

export class PlanNotFoundError extends Error {
  constructor(workspaceId: string) {
    super(`No plan found for workspace ${workspaceId}`);
    this.name = 'PlanNotFoundError';
  }
}
