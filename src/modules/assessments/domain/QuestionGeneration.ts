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
}

export interface GenerateQuestionsResult {
  questions: GeneratedQuestion[];
  /** Total schema repair attempts across all questions */
  totalSchemaRepairAttempts: number;
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
