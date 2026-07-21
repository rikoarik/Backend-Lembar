import type { QualityResult, QualityStore } from './Quality.js';

export class InMemoryQualityStore implements QualityStore {
  private readonly results: QualityResult[] = [];

  async save(result: QualityResult): Promise<QualityResult> {
    const copy = cloneResult(result);
    const index = this.results.findIndex(
      (item) =>
        item.workspaceId === result.workspaceId &&
        item.assessmentVersionId === result.assessmentVersionId,
    );
    if (index >= 0) this.results[index] = copy;
    else this.results.push(copy);
    return cloneResult(copy);
  }

  async get(workspaceId: string, assessmentVersionId: string): Promise<QualityResult | null> {
    const result = this.results.find(
      (item) =>
        item.workspaceId === workspaceId && item.assessmentVersionId === assessmentVersionId,
    );
    return result ? cloneResult(result) : null;
  }
}

function cloneResult(result: QualityResult): QualityResult {
  return {
    ...result,
    issues: result.issues.map((issue) => ({ ...issue })),
    summary: { ...result.summary },
    critic: result.critic
      ? {
          ...result.critic,
          issues: result.critic.issues.map((issue) => ({ ...issue })),
        }
      : null,
  };
}
