/**
 * B3-03 — Domain types for structured question generation.
 *
 * Transforms blueprint items into reviewable questions with stable options,
 * answer, explanation, and sources.
 *
 * Key invariants:
 * - GeneratedQuestion is immutable after creation.
 * - Each question pins the blueprint schema version and AI model version (D-013).
 * - Options are stable (deterministic order for multiple choice).
 * - Sources reference passage IDs from the blueprint's source evidence.
 * - Schema repair is bounded by a cap (D-013).
 */

import type { QuestionType, Difficulty } from './Assessment.js';

export type QuestionImageMode = 'none' | 'auto';
export type QuestionImageStyle = 'auto' | 'diagram' | 'illustration';

export interface QuestionImage {
  /** Optional so audit snapshots can retain metadata without duplicating image bytes. */
  dataUrl?: string;
  alt: string;
  mimeType: 'image/webp' | 'image/png';
  providerModelId: string;
}

export interface QuestionImageGenerationSettings {
  mode: QuestionImageMode;
  maxImages: number;
  style: QuestionImageStyle;
}

export interface QuestionImageGenerationRequest {
  prompt: string;
  alt: string;
  style: QuestionImageStyle;
}

export interface QuestionImageGenerator {
  generate(request: QuestionImageGenerationRequest): Promise<QuestionImage | null>;
}

export const DEFAULT_QUESTION_IMAGE_GENERATION: QuestionImageGenerationSettings = {
  mode: 'none',
  maxImages: 2,
  style: 'auto',
};

export type GenerationSourceMode = 'catalog' | 'pdf' | 'catalog_and_pdf';

/**
 * Teacher-authored context captured with an assessment version and passed to the generator.
 * It is intentionally bounded: curriculum and blueprint remain the source of competency truth.
 */
export interface QuestionGenerationContext {
  sourceMode: GenerationSourceMode;
  materialIds: string[];
  teacherFocus: string;
  exampleQuestion: string;
}

export const DEFAULT_QUESTION_GENERATION_CONTEXT: QuestionGenerationContext = {
  sourceMode: 'catalog',
  materialIds: [],
  teacherFocus: '',
  exampleQuestion: '',
};

export function normalizeQuestionGenerationContext(value: unknown): QuestionGenerationContext {
  if (!value || typeof value !== 'object') return { ...DEFAULT_QUESTION_GENERATION_CONTEXT };
  const raw = value as Record<string, unknown>;
  const sourceMode: GenerationSourceMode =
    raw.sourceMode === 'pdf' || raw.sourceMode === 'catalog_and_pdf' ? raw.sourceMode : 'catalog';
  const materialIds = Array.isArray(raw.materialIds)
    ? raw.materialIds
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .slice(0, 50)
    : [];
  const teacherFocus = typeof raw.teacherFocus === 'string' ? raw.teacherFocus.trim().slice(0, 500) : '';
  const exampleQuestion =
    typeof raw.exampleQuestion === 'string' ? raw.exampleQuestion.trim().slice(0, 2_000) : '';

  return { sourceMode, materialIds, teacherFocus, exampleQuestion };
}

export function normalizeQuestionImageGenerationSettings(
  value: unknown,
): QuestionImageGenerationSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_QUESTION_IMAGE_GENERATION };

  const raw = value as Record<string, unknown>;
  const mode: QuestionImageMode = raw['mode'] === 'auto' ? 'auto' : 'none';
  const style: QuestionImageStyle =
    raw['style'] === 'diagram' || raw['style'] === 'illustration' ? raw['style'] : 'auto';
  const parsedMax = typeof raw['maxImages'] === 'number' ? raw['maxImages'] : Number(raw['maxImages']);
  const maxImages = Number.isFinite(parsedMax)
    ? Math.min(5, Math.max(1, Math.floor(parsedMax)))
    : DEFAULT_QUESTION_IMAGE_GENERATION.maxImages;

  return { mode, maxImages, style };
}

// ---- Generated question ----

export interface GeneratedQuestion {
  id: string;
  assessmentVersionId: string;
  workspaceId: string;
  /** Blueprint item sequence this question was generated from */
  blueprintSequence: number;
  questionType: QuestionType;
  difficulty: Difficulty;
  /** The question text/stem */
  stem: string;
  /** For multiple choice / true-false: the options */
  options: QuestionOption[];
  /** The correct answer (for MC: option key; for short_answer/essay: expected answer text) */
  answer: string;
  /** Explanation of the answer */
  explanation: string;
  /** Source passage IDs used to ground this question */
  sourceIds: string[];
  /** Optional AI-generated visual aid. Image generation failure never invalidates the question. */
  image?: QuestionImage | null;
  /** Version metadata (D-013) */
  versionMetadata: QuestionVersionMetadata;
  createdAt: string;
}

export interface QuestionOption {
  /** Stable key (A, B, C, D for MC; true/false for T/F) */
  key: string;
  /** Option text */
  text: string;
}

export interface QuestionVersionMetadata {
  /** Blueprint schema version used when generating */
  blueprintSchemaVersion: string;
  /** AI provider model ID */
  providerModelId: string;
  /** AI prompt template ID */
  promptTemplateId: string;
  /** Number of schema repair attempts during generation */
  schemaRepairAttempts: number;
  /** Generation latency in ms */
  latencyMs: number;
}

// ---- Generation input ----

export interface GenerateQuestionsInput {
  workspaceId: string;
  assessmentVersionId: string;
  /** The validated blueprint to generate questions from */
  blueprintItems: Array<{
    sequence: number;
    questionType: QuestionType;
    difficulty: Difficulty;
    cognitiveLevel: string | null;
    topicHint: string | null;
    outcomeId: string | null;
    sourceUploadId: string | null;
    citationIds: string[];
  }>;
  /** Schema version for validation */
  blueprintSchemaVersion: string;
  /** Coverage targets for the generation */
  coverageTargets: {
    minTotalItems: number;
    maxTotalItems: number;
  };
  requestId: string;
  /** Optional queue job id, propagated to AI audit rows for correlation. */
  jobId?: string;
  /** Optional, bounded settings for generating visual aids. */
  imageGeneration?: QuestionImageGenerationSettings;
  /** Teacher-authored context that guides wording and source use without changing the blueprint. */
  generationContext?: QuestionGenerationContext;
  /** Optional per-question progress callback. Called after each question is generated. */
  onProgress?: (current: number, total: number) => Promise<void>;
}

export interface GenerateQuestionsResult {
  questions: GeneratedQuestion[];
  /** Total schema repair attempts across all questions */
  totalSchemaRepairAttempts: number;
  /** Number of questions that received an image. */
  imagesGenerated: number;
  /** Whether any questions failed generation */
  hasFailures: boolean;
  /** Per-question failures */
  failures: QuestionGenerationFailure[];
}

export interface QuestionGenerationFailure {
  blueprintSequence: number;
  reason: 'schema_repair_exhausted' | 'provider_error' | 'insufficient_source';
  message: string;
}

// ---- Store contract ----

export interface QuestionGenerationStore {
  saveQuestions(questions: GeneratedQuestion[]): Promise<GeneratedQuestion[]>;
  getQuestionsByAssessmentVersionId(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<GeneratedQuestion[]>;
  getQuestionById(workspaceId: string, questionId: string): Promise<GeneratedQuestion | null>;
}
