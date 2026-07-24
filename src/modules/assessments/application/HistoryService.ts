/**
 * B5-04 — HistoryService.
 *
 * Responsibilities:
 * - Paginated assessment history, tenant-scoped (cursor-based)
 * - Assessment detail with question snapshots (immutable configSnapshot preserved)
 * - Private question bank: saved questions per tenant/workspace
 *
 * Invariants:
 * - All reads are strictly scoped to workspaceId (tenant isolation)
 * - Question snapshots include full GeneratedQuestion data
 * - Pagination uses cursor (last seen assessmentId)
 */
import { ApiError } from '../../../common/errors/envelope.js';
import type { Assessment, AssessmentVersion, AssessmentsStore } from '../domain/Assessment.js';
import type { GeneratedQuestion, QuestionGenerationStore } from '../domain/QuestionGeneration.js';

export interface HistoryPage {
  items: Assessment[];
  nextCursor: string | null;
  total: number;
}

export interface AssessmentDetail {
  assessment: Assessment;
  version: AssessmentVersion | null;
  /** Immutable question snapshots for the latest version */
  questions: GeneratedQuestion[];
}

export interface BankPage {
  questions: GeneratedQuestion[];
  nextCursor: string | null;
}

export interface HistoryServiceOptions {
  assessmentsStore: AssessmentsStore;
  questionStore: QuestionGenerationStore;
}

export class HistoryService {
  constructor(private readonly options: HistoryServiceOptions) {}

  /**
   * Paginated assessment history for a workspace.
   * Sorted by createdAt descending (most recent first).
   *
   * @param workspaceId Tenant-scoped workspace ID
   * @param limit Number of items per page (max 100)
   * @param cursor Last seen assessment ID for pagination
   */
  async listHistory(
    workspaceId: string,
    limit: number = 20,
    cursor?: string,
  ): Promise<HistoryPage> {
    const clampedLimit = Math.min(Math.max(1, limit), 100);
    const items = await this.options.assessmentsStore.listAssessments(workspaceId, {
      limit: clampedLimit + 1, // fetch one extra to detect next page
      ...(cursor !== undefined ? { cursor } : {}),
    });

    const hasMore = items.length > clampedLimit;
    const pageItems = hasMore ? items.slice(0, clampedLimit) : items;
    const nextCursor = hasMore ? (pageItems[pageItems.length - 1]?.id ?? null) : null;

    // Get total count (all assessments for workspace, no pagination)
    const all = await this.options.assessmentsStore.listAssessments(workspaceId, { limit: 10000 });

    return {
      items: pageItems,
      nextCursor,
      total: all.length,
    };
  }

  /**
   * Assessment detail with question snapshots.
   * Returns the latest version's immutable configSnapshot + generated questions.
   *
   * @throws ApiError RESOURCE_NOT_FOUND (404) if assessment not found for this workspace
   */
  async getAssessmentDetail(
    workspaceId: string,
    assessmentId: string,
    requestId: string,
  ): Promise<AssessmentDetail> {
    const assessment = await this.options.assessmentsStore.getAssessmentById(
      workspaceId,
      assessmentId,
    );

    if (!assessment) {
      throw new ApiError({
        code: 'RESOURCE_NOT_FOUND',
        message: `Assessment ${assessmentId} not found.`,
        requestId,
      });
    }

    const version = await this.options.assessmentsStore.getLatestVersion(
      workspaceId,
      assessmentId,
    );

    let questions: GeneratedQuestion[] = [];
    if (version) {
      questions = await this.options.questionStore.getQuestionsByAssessmentVersionId(
        workspaceId,
        version.id,
      );
    }

    return { assessment, version, questions };
  }

  /**
   * Private question bank: all saved questions for a workspace.
   * Cursor-based pagination by question index.
   *
   * @param workspaceId Tenant-scoped workspace ID
   * @param limit Number of items per page (max 100)
   * @param afterIndex Cursor: skip this many questions (0-indexed)
   */
  async listBank(
    workspaceId: string,
    limit: number = 20,
    afterIndex: number = 0,
  ): Promise<BankPage> {
    const clampedLimit = Math.min(Math.max(1, limit), 100);

    // Collect all questions across all assessment versions for this workspace
    // by scanning all assessments
    const assessments = await this.options.assessmentsStore.listAssessments(workspaceId, {
      limit: 10000,
    });

    const allQuestions: GeneratedQuestion[] = [];
    for (const assessment of assessments) {
      const version = await this.options.assessmentsStore.getLatestVersion(
        workspaceId,
        assessment.id,
      );
      if (version) {
        const qs = await this.options.questionStore.getQuestionsByAssessmentVersionId(
          workspaceId,
          version.id,
        );
        allQuestions.push(...qs);
      }
    }

    // Sort by createdAt descending
    allQuestions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const slice = allQuestions.slice(afterIndex, afterIndex + clampedLimit + 1);
    const hasMore = slice.length > clampedLimit;
    const pageItems = hasMore ? slice.slice(0, clampedLimit) : slice;
    const nextCursor = hasMore ? String(afterIndex + clampedLimit) : null;

    return { questions: pageItems, nextCursor };
  }
}
