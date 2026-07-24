/**
 * B5-01 — PrintDocument DTO and template contract.
 *
 * Versioned print DTO with assessment content, question list, metadata.
 * Safe for serialisation — no internal IDs leaked beyond workspace boundary.
 *
 * Key invariants:
 * - dtoVersion is bumped when the shape changes (consumers can detect stale caches).
 * - workspaceId is always present so the caller can enforce tenant isolation.
 * - questions are ordered by blueprintSequence ascending.
 * - Each PrintQuestion carries a frozen snapshot of the accepted answer.
 */

import type { QuestionType, Difficulty } from './Assessment.js';

export const PRINT_DTO_VERSION = '1' as const;

export interface PrintQuestionOption {
  key: string;
  text: string;
}

export interface PrintQuestion {
  sequence: number;
  questionType: QuestionType;
  difficulty: Difficulty;
  stem: string;
  options: PrintQuestionOption[];
  /** Correct answer key / text — included in teacher copy only */
  answer: string;
  explanation: string;
}

export interface PrintDocumentMeta {
  /** DTO schema version — bump on breaking changes */
  dtoVersion: typeof PRINT_DTO_VERSION;
  /** Assessment UUID */
  assessmentId: string;
  /** Assessment version number */
  assessmentVersion: number;
  /** Workspace that owns this assessment */
  workspaceId: string;
  title: string;
  /** ISO-8601 of when the assessment was finalized */
  finalizedAt: string;
  /** ISO-8601 of when this DTO was generated */
  generatedAt: string;
}

export interface PrintDocument {
  meta: PrintDocumentMeta;
  questions: PrintQuestion[];
}
