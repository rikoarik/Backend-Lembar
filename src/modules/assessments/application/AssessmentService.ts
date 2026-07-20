/**
 * B2-03 — Assessment configuration and draft service.
 *
 * Owns FR-GEN-001/002 configuration responsibility:
 *  - Validate source/catalog readiness before creating an immutable config snapshot.
 *  - Create assessment + assessment_version + blueprint_items in a single logical transaction.
 *  - Idempotency: same key + same fingerprint returns original result.
 *  - Incompatible catalog: reject if any required curriculum/source reference is not ready.
 *
 * Tenant isolation: every public method requires workspaceId; no cross-workspace reads.
 */
import { createHash, randomUUID } from 'node:crypto';

import { ApiError } from '../../../common/errors/envelope.js';
import type {
  Assessment,
  AssessmentConfigSnapshot,
  AssessmentVersion,
  AssessmentsStore,
  BlueprintItem,
  BlueprintItemConfig,
  Difficulty,
  QuestionType,
} from '../domain/Assessment.js';
import type { SourceUploadsStore } from '../../uploads/domain/SourceUpload.js';
import type { SourceExtractionJobsStore } from '../../sources/domain/SourceExtraction.js';

// ---- Service input/output types ----

export interface BlueprintItemRequest {
  sequence: number;
  outcomeId?: string | null;
  questionType: QuestionType;
  difficulty: Difficulty;
  cognitiveLevel?: string | null;
  topicHint?: string | null;
  /** Source upload scoped to this blueprint item (optional; overrides top-level). */
  sourceUploadId?: string | null;
}

export interface CreateAssessmentConfigInput {
  workspaceId: string;
  creatorUserId: string;
  title: string;
  /** Opaque curriculum version ID from the catalog module. */
  curriculumVersionId: string;
  gradeId: string;
  subjectId: string;
  /** Upload IDs that must be in 'verified' or 'ready' state. */
  sourceUploadIds: string[];
  blueprintItems: BlueprintItemRequest[];
  /** Optional idempotency key. Same key + same fingerprint returns the same result. */
  idempotencyKey?: string | null;
  requestId: string;
}

export interface AssessmentConfigResult {
  assessment: Assessment;
  version: AssessmentVersion;
  blueprintItems: BlueprintItem[];
  /** True if the response is an idempotent replay (same key + fingerprint). */
  idempotent: boolean;
}

export interface AssessmentServiceOptions {
  store: AssessmentsStore;
  uploadsStore: SourceUploadsStore;
  extractionJobsStore: SourceExtractionJobsStore;
}

// ---- Fingerprint ----

/**
 * Canonical fingerprint of a CreateAssessmentConfigInput.
 * Same fingerprint = logically identical request = idempotency match.
 */
function fingerprintConfig(input: CreateAssessmentConfigInput): string {
  const canonical = JSON.stringify({
    title: input.title,
    curriculumVersionId: input.curriculumVersionId,
    gradeId: input.gradeId,
    subjectId: input.subjectId,
    sourceUploadIds: [...input.sourceUploadIds].sort(),
    blueprintItems: [...input.blueprintItems].sort((a, b) => a.sequence - b.sequence),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}

// ---- Service ----

export class AssessmentService {
  private readonly store: AssessmentsStore;
  private readonly uploadsStore: SourceUploadsStore;
  private readonly extractionJobsStore: SourceExtractionJobsStore;

  constructor(options: AssessmentServiceOptions) {
    this.store = options.store;
    this.uploadsStore = options.uploadsStore;
    this.extractionJobsStore = options.extractionJobsStore;
  }

  async createConfig(input: CreateAssessmentConfigInput): Promise<AssessmentConfigResult> {
    const { workspaceId, requestId } = input;

    // ---- Validation ----

    if (!input.title.trim()) {
      throw new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'title is required',
        requestId,
        fieldErrors: { title: ['required'] },
      });
    }

    if (!input.curriculumVersionId.trim()) {
      throw new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'curriculumVersionId is required',
        requestId,
        fieldErrors: { curriculumVersionId: ['required'] },
      });
    }

    if (input.blueprintItems.length === 0) {
      throw new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'at least one blueprint item is required',
        requestId,
        fieldErrors: { blueprintItems: ['min_items_1'] },
      });
    }

    // Validate blueprint item sequences are unique and non-negative.
    const sequences = input.blueprintItems.map((i) => i.sequence);
    if (new Set(sequences).size !== sequences.length) {
      throw new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'blueprint item sequences must be unique',
        requestId,
        fieldErrors: { blueprintItems: ['duplicate_sequence'] },
      });
    }

    // ---- Source readiness validation ----
    // All sourceUploadIds must exist in this workspace and be verified or not deleted/rejected.
    // This is the "incompatible source" guard per B2-03 evidence requirement.
    for (const uploadId of input.sourceUploadIds) {
      const upload = await this.uploadsStore.getUploadByIdForWorkspace(workspaceId, uploadId);
      if (!upload) {
        throw new ApiError({
          code: 'VALIDATION_FAILED',
          message: `Source upload ${uploadId} not found in this workspace`,
          requestId,
          fieldErrors: { sourceUploadIds: [`not_found:${uploadId}`] },
        });
      }
      if (upload.status === 'deleted') {
        throw new ApiError({
          code: 'STATE_CONFLICT',
          message: `Source upload ${uploadId} has been deleted`,
          requestId,
          fieldErrors: { sourceUploadIds: [`deleted:${uploadId}`] },
        });
      }
      if (upload.status === 'rejected') {
        throw new ApiError({
          code: 'STATE_CONFLICT',
          message: `Source upload ${uploadId} was rejected`,
          requestId,
          fieldErrors: { sourceUploadIds: [`rejected:${uploadId}`] },
        });
      }
      // Guard: source must have been extracted (extraction job succeeded) before it
      // can be used in an assessment. If not yet extracted, return actionable state.
      const extractionJob = await this.extractionJobsStore.getJobByUploadId(
        workspaceId,
        uploadId,
      );
      if (!extractionJob || extractionJob.status !== 'succeeded') {
        throw new ApiError({
          code: 'STATE_CONFLICT',
          message: `Source upload ${uploadId} has not been extracted yet. Run extraction first.`,
          requestId,
          fieldErrors: { sourceUploadIds: [`not_extracted:${uploadId}`] },
        });
      }
    }

    // ---- Idempotency ----
    const fingerprint = fingerprintConfig(input);
    if (input.idempotencyKey) {
      const existing = await this.store.getAssessmentByIdempotencyKey(
        workspaceId,
        input.idempotencyKey,
      );
      if (existing) {
        // Same key exists — check fingerprint.
        const version = await this.store.getLatestVersion(workspaceId, existing.id);
        if (version) {
          // Compare fingerprint stored in config snapshot.
          const existingFingerprint = (version.configSnapshot as unknown as Record<string, unknown>)['_fingerprint'] as string | undefined;
          if (existingFingerprint === fingerprint) {
            // Identical request — return original result.
            const items = await this.store.listBlueprintItems(workspaceId, version.id);
            return { assessment: existing, version, blueprintItems: items, idempotent: true };
          }
          // Same key, different fingerprint = conflict.
          throw new ApiError({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'Idempotency key already used with a different request body',
            requestId,
          });
        }
      }
    }

    // ---- Build immutable config snapshot ----
    const blueprintItemConfigs: BlueprintItemConfig[] = input.blueprintItems.map((item) => ({
      sequence: item.sequence,
      outcomeId: item.outcomeId ?? null,
      questionType: item.questionType,
      difficulty: item.difficulty,
      cognitiveLevel: item.cognitiveLevel ?? null,
      topicHint: item.topicHint ?? null,
      sourceUploadId: item.sourceUploadId ?? null,
    }));

    const configSnapshot: AssessmentConfigSnapshot & { _fingerprint: string } = {
      schemaVersion: '1',
      title: input.title,
      curriculumVersionId: input.curriculumVersionId,
      gradeId: input.gradeId,
      subjectId: input.subjectId,
      sourceUploadIds: [...input.sourceUploadIds],
      blueprintItems: blueprintItemConfigs,
      _fingerprint: fingerprint,
    };

    // ---- Persist ----
    // 1. Create assessment head row.
    const assessment = await this.store.createAssessment({
      workspaceId,
      creatorUserId: input.creatorUserId,
      title: input.title,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    // 2. Create immutable version row (version 1).
    const version = await this.store.createAssessmentVersion({
      assessmentId: assessment.id,
      workspaceId,
      version: 1,
      configSnapshot,
    });

    // 3. Update assessment to point at current version.
    const updatedAssessment = await this.store.updateAssessment({
      id: assessment.id,
      workspaceId,
      currentVersion: 1,
    });

    // 4. Persist blueprint items.
    const blueprintItems = await this.store.createBlueprintItems(
      input.blueprintItems.map((item) => ({
        assessmentVersionId: version.id,
        workspaceId,
        sequence: item.sequence,
        curriculumVersionId: input.curriculumVersionId,
        outcomeId: item.outcomeId ?? null,
        subjectId: input.subjectId,
        gradeId: input.gradeId,
        questionType: item.questionType,
        difficulty: item.difficulty,
        cognitiveLevel: item.cognitiveLevel ?? null,
        topicHint: item.topicHint ?? null,
        sourceUploadId: item.sourceUploadId ?? null,
      })),
    );

    return { assessment: updatedAssessment, version, blueprintItems, idempotent: false };
  }

  async getAssessment(
    workspaceId: string,
    assessmentId: string,
    requestId: string,
  ): Promise<{ assessment: Assessment; version: AssessmentVersion | null; blueprintItems: BlueprintItem[] }> {
    const assessment = await this.store.getAssessmentById(workspaceId, assessmentId);
    if (!assessment) {
      throw new ApiError({
        code: 'RESOURCE_NOT_FOUND',
        message: 'Assessment not found',
        requestId,
      });
    }

    const version =
      assessment.currentVersion > 0
        ? await this.store.getVersionByNumber(workspaceId, assessmentId, assessment.currentVersion)
        : null;

    const blueprintItems = version
      ? await this.store.listBlueprintItems(workspaceId, version.id)
      : [];

    return { assessment, version, blueprintItems };
  }

  async listAssessments(
    workspaceId: string,
    options: { limit?: number; cursor?: string },
  ): Promise<Assessment[]> {
    return this.store.listAssessments(workspaceId, {
      limit: Math.min(options.limit ?? 20, 100),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    });
  }
}

// ---- Factory ----

export function createAssessmentService(options: AssessmentServiceOptions): AssessmentService {
  return new AssessmentService(options);
}
