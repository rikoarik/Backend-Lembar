/**
 * B2-03 — In-memory implementation of AssessmentsStore.
 *
 * Used by unit tests and smoke; mirrors DB schema exactly.
 */
import { randomUUID } from 'node:crypto';

import type {
  Assessment,
  AssessmentVersion,
  AssessmentsStore,
  BlueprintItem,
  CreateAssessmentInput,
  CreateAssessmentVersionInput,
  CreateBlueprintItemInput,
  UpdateAssessmentInput,
} from '../domain/Assessment.js';

export class InMemoryAssessmentsStore implements AssessmentsStore {
  private readonly assessments = new Map<string, Assessment>();
  private readonly versions: AssessmentVersion[] = [];
  private readonly items: BlueprintItem[] = [];

  async createAssessment(input: CreateAssessmentInput): Promise<Assessment> {
    const now = new Date().toISOString();
    const assessment: Assessment = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      creatorUserId: input.creatorUserId,
      title: input.title,
      status: 'draft',
      currentVersion: 0,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.assessments.set(assessment.id, assessment);
    return { ...assessment };
  }

  async getAssessmentById(workspaceId: string, id: string): Promise<Assessment | null> {
    const a = this.assessments.get(id);
    if (!a || a.workspaceId !== workspaceId) return null;
    return { ...a };
  }

  async getAssessmentByIdempotencyKey(
    workspaceId: string,
    key: string,
  ): Promise<Assessment | null> {
    for (const a of this.assessments.values()) {
      if (a.workspaceId === workspaceId && a.idempotencyKey === key) return { ...a };
    }
    return null;
  }

  async listAssessments(
    workspaceId: string,
    options: { limit: number; cursor?: string },
  ): Promise<Assessment[]> {
    const { limit, cursor } = options;
    const all = [...this.assessments.values()]
      .filter((a) => a.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const startIdx = cursor
      ? all.findIndex((a) => a.id === cursor) + 1
      : 0;

    return all.slice(startIdx, startIdx + limit).map((a) => ({ ...a }));
  }

  async updateAssessment(input: UpdateAssessmentInput): Promise<Assessment> {
    const existing = this.assessments.get(input.id);
    if (!existing || existing.workspaceId !== input.workspaceId) {
      throw new Error(`Assessment not found: ${input.id}`);
    }
    const updated: Assessment = {
      ...existing,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.currentVersion !== undefined ? { currentVersion: input.currentVersion } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.assessments.set(updated.id, updated);
    return { ...updated };
  }

  async createAssessmentVersion(
    input: CreateAssessmentVersionInput,
  ): Promise<AssessmentVersion> {
    const version: AssessmentVersion = {
      id: randomUUID(),
      assessmentId: input.assessmentId,
      workspaceId: input.workspaceId,
      version: input.version,
      status: 'draft',
      configSnapshot: input.configSnapshot,
      schemaVersion: '1',
      createdAt: new Date().toISOString(),
    };
    this.versions.push(version);
    return { ...version };
  }

  async getLatestVersion(
    workspaceId: string,
    assessmentId: string,
  ): Promise<AssessmentVersion | null> {
    const matching = this.versions
      .filter((v) => v.workspaceId === workspaceId && v.assessmentId === assessmentId)
      .sort((a, b) => b.version - a.version);
    return matching[0] ? { ...matching[0] } : null;
  }

  async getVersionByNumber(
    workspaceId: string,
    assessmentId: string,
    version: number,
  ): Promise<AssessmentVersion | null> {
    const v = this.versions.find(
      (v) =>
        v.workspaceId === workspaceId &&
        v.assessmentId === assessmentId &&
        v.version === version,
    );
    return v ? { ...v } : null;
  }

  async createBlueprintItems(inputs: CreateBlueprintItemInput[]): Promise<BlueprintItem[]> {
    const now = new Date().toISOString();
    const results: BlueprintItem[] = [];
    for (const input of inputs) {
      const item: BlueprintItem = {
        id: randomUUID(),
        assessmentVersionId: input.assessmentVersionId,
        workspaceId: input.workspaceId,
        sequence: input.sequence,
        curriculumVersionId: input.curriculumVersionId ?? null,
        outcomeId: input.outcomeId ?? null,
        subjectId: input.subjectId ?? null,
        gradeId: input.gradeId ?? null,
        questionType: input.questionType,
        difficulty: input.difficulty,
        cognitiveLevel: input.cognitiveLevel ?? null,
        topicHint: input.topicHint ?? null,
        sourceUploadId: input.sourceUploadId ?? null,
        createdAt: now,
      };
      this.items.push(item);
      results.push({ ...item });
    }
    return results;
  }

  async listBlueprintItems(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<BlueprintItem[]> {
    return this.items
      .filter(
        (i) => i.workspaceId === workspaceId && i.assessmentVersionId === assessmentVersionId,
      )
      .sort((a, b) => a.sequence - b.sequence)
      .map((i) => ({ ...i }));
  }
}
