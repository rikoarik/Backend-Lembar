/**
 * B3-02 — In-memory implementation of BlueprintPipelineStore.
 *
 * Used by unit tests and smoke; mirrors DB schema exactly.
 */
import type {
  BlueprintPipelineStore,
  BlueprintSchemaVersion,
  BlueprintSnapshot,
} from '../domain/BlueprintPipeline.js';

export class InMemoryBlueprintPipelineStore implements BlueprintPipelineStore {
  private readonly snapshots: BlueprintSnapshot[] = [];
  private readonly schemas = new Map<string, BlueprintSchemaVersion>();

  constructor() {
    // Seed the default schema version
    this.schemas.set('1.0.0', {
      version: '1.0.0',
      publishedAt: '2025-01-01T00:00:00.000Z',
      itemSchema: {
        requiredFields: ['sequence', 'questionType', 'difficulty'],
        allowedQuestionTypes: ['multiple_choice', 'short_answer', 'essay', 'true_false'],
        allowedDifficulties: ['easy', 'medium', 'hard'],
        allowedCognitiveLevels: null,
        maxSequence: 999,
        requireSourceUploadId: false,
      },
    });
  }

  async saveSnapshot(snapshot: BlueprintSnapshot): Promise<BlueprintSnapshot> {
    const copy = {
      ...snapshot,
      items: [...snapshot.items.map((item) => ({ ...item }))],
      coverageReport: { ...snapshot.coverageReport },
      sourceEvidence: [...snapshot.sourceEvidence],
    };
    this.snapshots.push(copy);
    return { ...copy, items: [...copy.items.map((item) => ({ ...item }))] };
  }

  async getSnapshotByAssessmentVersionId(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<BlueprintSnapshot | null> {
    const snap = this.snapshots.find(
      (s) => s.workspaceId === workspaceId && s.assessmentVersionId === assessmentVersionId,
    );
    if (!snap) return null;
    return {
      ...snap,
      items: [...snap.items.map((item) => ({ ...item }))],
      coverageReport: { ...snap.coverageReport },
      sourceEvidence: [...snap.sourceEvidence],
    };
  }

  async getSchemaVersion(version: string): Promise<BlueprintSchemaVersion | null> {
    const schema = this.schemas.get(version);
    return schema ? { ...schema } : null;
  }

  addSchemaVersion(schema: BlueprintSchemaVersion): void {
    this.schemas.set(schema.version, schema);
  }
}
