import type { BlueprintSnapshot } from '../domain/BlueprintPipeline.js';
import type { GeneratedQuestion } from '../domain/QuestionGeneration.js';

export const QUALITY_RULESET_VERSION = '1.0.0';

export type QualityIssueCode =
  | 'duplicate_question'
  | 'invalid_answer'
  | 'invalid_options'
  | 'source_coverage'
  | 'distribution_mismatch'
  | 'prompt_injection';

export interface QualityRuleSet {
  /** Similarity at or above this value is a duplicate. */
  duplicateSimilarityThreshold: number;
  /** Maximum number of critic issues retained in the result. */
  maxCriticIssues: number;
  /** Maximum critic attempts for one quality run. */
  maxCriticAttempts: number;
  /** Maximum characters retained from a critic rationale. */
  maxCriticRationaleChars: number;
}

export const DEFAULT_QUALITY_RULES: Readonly<QualityRuleSet> = {
  duplicateSimilarityThreshold: 0.85,
  maxCriticIssues: 5,
  maxCriticAttempts: 1,
  maxCriticRationaleChars: 280,
};

export interface QualityIssue {
  code: QualityIssueCode;
  message: string;
  sequence?: number;
  relatedSequence?: number;
  score?: number;
}

export interface CriticIssue {
  code: string;
  message: string;
  sequence?: number;
}

/** Deliberately excludes provider output, hidden reasoning, and raw prompts. */
export interface StoredCriticResult {
  accepted: boolean;
  issues: CriticIssue[];
  rationale: string | null;
  attempts: number;
  injectionDetected: boolean;
}

export interface QualitySummary {
  questionCount: number;
  deterministicIssueCount: number;
  duplicateCount: number;
  answerIssueCount: number;
  sourceIssueCount: number;
  distributionIssueCount: number;
  promptInjectionCount: number;
}

export interface QualityResult {
  id: string;
  workspaceId: string;
  assessmentVersionId: string;
  rulesetVersion: string;
  valid: boolean;
  issues: QualityIssue[];
  summary: QualitySummary;
  critic: StoredCriticResult | null;
  createdAt: string;
}

export interface QualityCheckInput {
  workspaceId: string;
  assessmentVersionId: string;
  questions: readonly GeneratedQuestion[];
  blueprint: BlueprintSnapshot;
  rules?: Partial<QualityRuleSet>;
  requestId?: string;
}

export interface QualityStore {
  save(result: QualityResult): Promise<QualityResult>;
  get(workspaceId: string, assessmentVersionId: string): Promise<QualityResult | null>;
}

export interface CriticQuestion {
  sequence: number;
  questionType: GeneratedQuestion['questionType'];
  difficulty: GeneratedQuestion['difficulty'];
  stem: string;
  options: Array<{ key: string; text: string }>;
  answer: string;
  explanation: string;
  sourceIds: string[];
}

export interface QualityCriticInput {
  workspaceId: string;
  assessmentVersionId: string;
  questions: readonly CriticQuestion[];
  deterministicIssues: readonly QualityIssue[];
  /** Delimited data prompt; source text is untrusted and never an instruction. */
  prompt: string;
}

export interface QualityCriticEvaluation {
  accepted: boolean;
  issues?: readonly CriticIssue[];
  rationale?: string | null;
}

export interface QualityCriticEvaluator {
  evaluate(input: QualityCriticInput): Promise<QualityCriticEvaluation>;
}

export function mergeQualityRules(rules?: Partial<QualityRuleSet>): QualityRuleSet {
  const merged = { ...DEFAULT_QUALITY_RULES, ...rules };
  if (
    !Number.isFinite(merged.duplicateSimilarityThreshold) ||
    merged.duplicateSimilarityThreshold < 0 ||
    merged.duplicateSimilarityThreshold > 1
  ) {
    throw new Error('duplicateSimilarityThreshold must be between 0 and 1');
  }
  if (!Number.isInteger(merged.maxCriticIssues) || merged.maxCriticIssues < 0) {
    throw new Error('maxCriticIssues must be a non-negative integer');
  }
  if (!Number.isInteger(merged.maxCriticAttempts) || merged.maxCriticAttempts < 0) {
    throw new Error('maxCriticAttempts must be a non-negative integer');
  }
  if (!Number.isInteger(merged.maxCriticRationaleChars) || merged.maxCriticRationaleChars < 0) {
    throw new Error('maxCriticRationaleChars must be a non-negative integer');
  }
  return merged;
}
