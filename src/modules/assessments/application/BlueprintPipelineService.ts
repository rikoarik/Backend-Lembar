/**
 * B3-02 — Blueprint pipeline service.
 *
 * Transforms an AssessmentVersion's config snapshot into a validated,
 * schema-constrained blueprint with coverage enforcement and source grounding.
 *
 * Pipeline steps:
 * 1. Load assessment version and its config snapshot.
 * 2. Retrieve source passages via SourceRetrievalService (B3-01).
 * 3. Validate blueprint items against the versioned schema.
 * 4. Enforce coverage targets (difficulty, question type distribution).
 * 5. Build immutable BlueprintSnapshot (D-013).
 *
 * Insufficient-source handling:
 * - Propagates InsufficientSourceError from retrieval.
 * - Returns actionable error when sources cannot ground the blueprint.
 *
 * Tenant isolation: every operation requires workspaceId.
 */
import { randomUUID } from 'node:crypto';

import { ApiError } from '../../../common/errors/envelope.js';
import { InsufficientSourceError } from '../../sources/domain/SourceRetrieval.js';
import type { SourceRetrievalService } from '../../sources/application/SourceRetrievalService.js';
import type { AssessmentsStore } from '../domain/Assessment.js';
import type { AssessmentVersion } from '../domain/Assessment.js';
import type {
  BlueprintPipelineStore,
  BlueprintSchemaVersion,
  BlueprintSnapshot,
  BlueprintSnapshotItem,
  BlueprintValidationResult,
  BlueprintValidationError,
  BuildBlueprintInput,
  BuildBlueprintResult,
  CoverageReport,
  CoverageTargets,
  CoverageViolation,
  SourceEvidence,
} from '../domain/BlueprintPipeline.js';

// ---- Service options ----

export interface BlueprintPipelineServiceOptions {
  store: BlueprintPipelineStore;
  assessmentsStore: AssessmentsStore;
  retrievalService: SourceRetrievalService;
}

// ---- Service ----

export class BlueprintPipelineService {
  private readonly store: BlueprintPipelineStore;
  private readonly assessmentsStore: AssessmentsStore;
  private readonly retrievalService: SourceRetrievalService;

  constructor(options: BlueprintPipelineServiceOptions) {
    this.store = options.store;
    this.assessmentsStore = options.assessmentsStore;
    this.retrievalService = options.retrievalService;
  }

  /**
   * Build a validated blueprint for an assessment version.
   *
   * Returns a cached snapshot if one already exists for this version.
   */
  async buildBlueprint(input: BuildBlueprintInput): Promise<BuildBlueprintResult> {
    const { workspaceId, assessmentVersionId, blueprintSchemaVersion, coverageTargets, requestId } =
      input;

    // ---- 1. Check for existing snapshot ----
    const existing = await this.store.getSnapshotByAssessmentVersionId(
      workspaceId,
      assessmentVersionId,
    );
    if (existing) {
      const validation = this.validateSnapshot(existing, coverageTargets);
      return { snapshot: existing, validation, cached: true };
    }

    // ---- 2. Load assessment version ----
    const version = await this.loadVersion(workspaceId, assessmentVersionId, requestId);
    const config = version.configSnapshot;

    // ---- 3. Validate schema version exists ----
    const schema = await this.store.getSchemaVersion(blueprintSchemaVersion);
    if (!schema) {
      throw new ApiError({
        code: 'VALIDATION_FAILED',
        message: `Blueprint schema version ${blueprintSchemaVersion} not found`,
        requestId,
        fieldErrors: { blueprintSchemaVersion: ['not_found'] },
      });
    }

    // ---- 4. Retrieve source passages ----
    let sourceEvidence: SourceEvidence[] = [];
    const sourceUploadIds = config.sourceUploadIds;

    if (sourceUploadIds.length > 0) {
      try {
        const retrievalResult = await this.retrievalService.retrieve({
          workspaceId,
          sourceUploadIds,
        });

        // Build evidence from retrieval result
        const evidenceByUpload = new Map<string, { count: number; charCount: number }>();
        for (const passage of retrievalResult.passages) {
          const entry = evidenceByUpload.get(passage.uploadId) ?? { count: 0, charCount: 0 };
          entry.count += 1;
          entry.charCount += passage.charCount;
          evidenceByUpload.set(passage.uploadId, entry);
        }
        sourceEvidence = sourceUploadIds.map((uploadId) => ({
          uploadId,
          passageCount: evidenceByUpload.get(uploadId)?.count ?? 0,
          totalCharCount: evidenceByUpload.get(uploadId)?.charCount ?? 0,
        }));
      } catch (err) {
        if (err instanceof InsufficientSourceError) {
          throw new ApiError({
            code: 'STATE_CONFLICT',
            message: `Insufficient source for blueprint generation: ${err.reason}`,
            requestId,
            fieldErrors: {
              sourceUploadIds: [err.reason, ...err.uploadIds],
            },
          });
        }
        throw err;
      }
    }

    // ---- 5. Validate items against schema ----
    const items: BlueprintSnapshotItem[] = config.blueprintItems.map((item) => ({
      sequence: item.sequence,
      questionType: item.questionType,
      difficulty: item.difficulty,
      cognitiveLevel: item.cognitiveLevel ?? null,
      topicHint: item.topicHint ?? null,
      outcomeId: item.outcomeId ?? null,
      sourceUploadId: item.sourceUploadId ?? null,
      citationIds: [],
    }));

    const validation = this.validateAgainstSchema(items, schema, coverageTargets);

    // ---- 6. Build coverage report ----
    const coverageReport = this.buildCoverageReport(items, coverageTargets);

    // ---- 7. Create immutable snapshot ----
    const snapshot: BlueprintSnapshot = {
      id: randomUUID(),
      assessmentVersionId,
      workspaceId,
      blueprintSchemaVersion,
      items,
      coverageReport,
      sourceEvidence,
      createdAt: new Date().toISOString(),
    };

    await this.store.saveSnapshot(snapshot);

    return { snapshot, validation, cached: false };
  }

  /**
   * Retrieve an existing blueprint snapshot for an assessment version.
   */
  async getBlueprint(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<BlueprintSnapshot | null> {
    return this.store.getSnapshotByAssessmentVersionId(workspaceId, assessmentVersionId);
  }

  // ---- Private helpers ----

  private async loadVersion(
    workspaceId: string,
    assessmentVersionId: string,
    requestId: string,
  ): Promise<AssessmentVersion> {
    const version = await this.assessmentsStore.getVersionById(workspaceId, assessmentVersionId);

    if (!version) {
      throw new ApiError({
        code: 'RESOURCE_NOT_FOUND',
        message: 'Assessment version not found',
        requestId,
      });
    }

    return version;
  }

  private validateAgainstSchema(
    items: BlueprintSnapshotItem[],
    schema: BlueprintSchemaVersion,
    coverageTargets: CoverageTargets,
  ): BlueprintValidationResult {
    const errors: BlueprintValidationError[] = [];
    const { itemSchema } = schema;

    // Check total items
    if (items.length < coverageTargets.minTotalItems) {
      errors.push({
        code: 'total_items_below_min',
        message: `Total items (${items.length}) below minimum (${coverageTargets.minTotalItems})`,
      });
    }
    if (items.length > coverageTargets.maxTotalItems) {
      errors.push({
        code: 'total_items_above_max',
        message: `Total items (${items.length}) above maximum (${coverageTargets.maxTotalItems})`,
      });
    }

    // Validate each item
    const sequences = new Set<number>();
    for (const item of items) {
      // Duplicate sequence
      if (sequences.has(item.sequence)) {
        errors.push({
          code: 'duplicate_sequence',
          message: `Duplicate sequence: ${item.sequence}`,
          sequence: item.sequence,
        });
      }
      sequences.add(item.sequence);

      // Sequence range
      if (item.sequence < 0 || item.sequence > itemSchema.maxSequence) {
        errors.push({
          code: 'sequence_out_of_range',
          message: `Sequence ${item.sequence} out of range [0, ${itemSchema.maxSequence}]`,
          sequence: item.sequence,
        });
      }

      // Question type
      if (!itemSchema.allowedQuestionTypes.includes(item.questionType)) {
        errors.push({
          code: 'invalid_question_type',
          message: `Invalid question type: ${item.questionType}`,
          field: 'questionType',
          sequence: item.sequence,
        });
      }

      // Difficulty
      if (!itemSchema.allowedDifficulties.includes(item.difficulty)) {
        errors.push({
          code: 'invalid_difficulty',
          message: `Invalid difficulty: ${item.difficulty}`,
          field: 'difficulty',
          sequence: item.sequence,
        });
      }

      // Cognitive level
      if (
        itemSchema.allowedCognitiveLevels !== null &&
        item.cognitiveLevel !== null &&
        !itemSchema.allowedCognitiveLevels.includes(item.cognitiveLevel)
      ) {
        errors.push({
          code: 'invalid_cognitive_level',
          message: `Invalid cognitive level: ${item.cognitiveLevel}`,
          field: 'cognitiveLevel',
          sequence: item.sequence,
        });
      }

      // Source upload ID required
      if (itemSchema.requireSourceUploadId && !item.sourceUploadId) {
        errors.push({
          code: 'missing_source_upload_id',
          message: `Source upload ID required for item at sequence ${item.sequence}`,
          field: 'sourceUploadId',
          sequence: item.sequence,
        });
      }
    }

    // Coverage distribution checks
    const coverageReport = this.buildCoverageReport(items, coverageTargets);
    for (const violation of coverageReport.violations) {
      errors.push({
        code: violation.target as BlueprintValidationError['code'],
        message: violation.message,
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  private validateSnapshot(
    snapshot: BlueprintSnapshot,
    coverageTargets: CoverageTargets,
  ): BlueprintValidationResult {
    // For cached snapshots, only validate coverage (schema was already validated)
    const errors: BlueprintValidationError[] = [];

    // Check total items
    if (snapshot.items.length < coverageTargets.minTotalItems) {
      errors.push({
        code: 'total_items_below_min',
        message: `Total items (${snapshot.items.length}) below minimum (${coverageTargets.minTotalItems})`,
      });
    }
    if (snapshot.items.length > coverageTargets.maxTotalItems) {
      errors.push({
        code: 'total_items_above_max',
        message: `Total items (${snapshot.items.length}) above maximum (${coverageTargets.maxTotalItems})`,
      });
    }

    const coverageReport = this.buildCoverageReport(snapshot.items, coverageTargets);
    for (const violation of coverageReport.violations) {
      errors.push({
        code: violation.target as BlueprintValidationError['code'],
        message: violation.message,
      });
    }
    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  private buildCoverageReport(
    items: BlueprintSnapshotItem[],
    targets: CoverageTargets,
  ): CoverageReport {
    const difficultyCounts: Record<string, number> = {
      easy: 0,
      medium: 0,
      hard: 0,
    };
    const questionTypeCounts: Record<string, number> = {
      multiple_choice: 0,
      short_answer: 0,
      essay: 0,
      true_false: 0,
    };
    let itemsWithSource = 0;

    for (const item of items) {
      difficultyCounts[item.difficulty] = (difficultyCounts[item.difficulty] ?? 0) + 1;
      questionTypeCounts[item.questionType] = (questionTypeCounts[item.questionType] ?? 0) + 1;
      if (item.sourceUploadId) {
        itemsWithSource += 1;
      }
    }

    const total = items.length;
    const violations: CoverageViolation[] = [];

    // Difficulty distribution
    for (const [diff, targetFraction] of Object.entries(targets.difficultyDistribution)) {
      const actualCount = difficultyCounts[diff] ?? 0;
      const actualFraction = total > 0 ? actualCount / total : 0;
      // Allow 10% tolerance
      if (actualFraction < targetFraction - 0.1) {
        violations.push({
          target: 'difficulty_distribution_mismatch',
          expected: targetFraction,
          actual: actualFraction,
          message: `Difficulty "${diff}" distribution ${(actualFraction * 100).toFixed(0)}% below target ${(targetFraction * 100).toFixed(0)}%`,
        });
      }
    }

    // Question type distribution
    for (const [qt, targetFraction] of Object.entries(targets.questionTypeDistribution)) {
      const actualCount = questionTypeCounts[qt] ?? 0;
      const actualFraction = total > 0 ? actualCount / total : 0;
      if (actualFraction < targetFraction - 0.1) {
        violations.push({
          target: 'question_type_distribution_mismatch',
          expected: targetFraction,
          actual: actualFraction,
          message: `Question type "${qt}" distribution ${(actualFraction * 100).toFixed(0)}% below target ${(targetFraction * 100).toFixed(0)}%`,
        });
      }
    }

    // Source coverage
    const sourceCoverageFraction = total > 0 ? itemsWithSource / total : 0;
    if (sourceCoverageFraction < targets.minSourceCoverage) {
      violations.push({
        target: 'source_coverage_below_min',
        expected: targets.minSourceCoverage,
        actual: sourceCoverageFraction,
        message: `Source coverage ${(sourceCoverageFraction * 100).toFixed(0)}% below minimum ${(targets.minSourceCoverage * 100).toFixed(0)}%`,
      });
    }

    return {
      totalItems: total,
      difficultyCounts: difficultyCounts as Record<string, number> as Record<
        import('../domain/Assessment.js').Difficulty,
        number
      >,
      questionTypeCounts: questionTypeCounts as Record<string, number> as Record<
        import('../domain/Assessment.js').QuestionType,
        number
      >,
      itemsWithSource,
      sourceCoverageFraction,
      meetsTargets: violations.length === 0,
      violations,
    };
  }
}

// ---- Factory ----

export function createBlueprintPipelineService(
  options: BlueprintPipelineServiceOptions,
): BlueprintPipelineService {
  return new BlueprintPipelineService(options);
}

// ---- Default schema and coverage targets ----

export const BLUEPRINT_SCHEMA_V1: BlueprintSchemaVersion = {
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
};

export const DEFAULT_COVERAGE_TARGETS: CoverageTargets = {
  minTotalItems: 1,
  maxTotalItems: 100,
  difficultyDistribution: {
    easy: 0.2,
    medium: 0.5,
    hard: 0.3,
  },
  questionTypeDistribution: {
    multiple_choice: 0.4,
    short_answer: 0.3,
    essay: 0.2,
    true_false: 0.1,
  },
  minSourceCoverage: 0.5,
};
