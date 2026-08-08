import type { GeneratedQuestion, QuestionGenerationStore } from '../domain/QuestionGeneration.js';

/**
 * Postgres-backed implementation of the `QuestionGenerationStore` contract.
 *
 * ponytail: every column type mirrors the migration in
 * `0023_generated_questions.sql`. Use the Postgres store when
 * `DATABASE_URL` is set so generated questions survive worker↔API
 * process restarts; local smoke and unit tests use
 * `InMemoryQuestionGenerationStore`.
 */
type PgExecutor = {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export class PostgresQuestionGenerationStore implements QuestionGenerationStore {
  constructor(private readonly exec: PgExecutor) {}

  async saveQuestions(questions: GeneratedQuestion[]): Promise<GeneratedQuestion[]> {
    if (questions.length === 0) return [];
    const sql = `INSERT INTO "generated_questions" (
      "id", "workspace_id", "assessment_version_id", "blueprint_sequence",
      "question_type", "difficulty", "stem", "options", "answer",
      "explanation", "source_ids", "version_metadata", "created_at"
    ) VALUES %ROWS%
    ON CONFLICT ("id") DO NOTHING
    RETURNING *`;
    const params: unknown[] = [];
    const tuples = questions.map((q, i) => {
      const base = i * 13;
      const createdAt = q.createdAt ? new Date(q.createdAt) : new Date();
      params.push(
        q.id,
        q.workspaceId,
        q.assessmentVersionId,
        q.blueprintSequence,
        q.questionType,
        q.difficulty,
        q.stem,
        JSON.stringify(q.options),
        q.answer,
        q.explanation,
        JSON.stringify(q.sourceIds),
        JSON.stringify(q.versionMetadata),
        createdAt,
      );
      return `($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::jsonb, $${base + 9}, $${base + 10}, $${base + 11}::jsonb, $${base + 12}::jsonb, $${base + 13}::timestamptz)`;
    });
    const finalSql = sql.replace('%ROWS%', tuples.join(', '));
    const result = await this.exec.query<QuestionRow>(finalSql, params);
    return result.rows.map((row) => rowToQuestion(row));
  }

  async getQuestionsByAssessmentVersionId(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<GeneratedQuestion[]> {
    const result = await this.exec.query<QuestionRow>(
      `SELECT * FROM "generated_questions"
        WHERE "workspace_id" = $1 AND "assessment_version_id" = $2
        ORDER BY "blueprint_sequence" ASC`,
      [workspaceId, assessmentVersionId],
    );
    return result.rows.map((row) => rowToQuestion(row));
  }

  async getQuestionById(
    workspaceId: string,
    questionId: string,
  ): Promise<GeneratedQuestion | null> {
    const result = await this.exec.query<QuestionRow>(
      `SELECT * FROM "generated_questions"
        WHERE "workspace_id" = $1 AND "id" = $2 LIMIT 1`,
      [workspaceId, questionId],
    );
    const row = result.rows[0];
    return row ? rowToQuestion(row) : null;
  }
}

interface QuestionRow {
  id: string;
  workspace_id: string;
  assessment_version_id: string;
  blueprint_sequence: number;
  question_type: string;
  difficulty: string;
  stem: string;
  options: unknown;
  answer: string;
  explanation: string;
  source_ids: unknown;
  version_metadata: unknown;
  created_at: Date | string;
}

function rowToQuestion(row: QuestionRow): GeneratedQuestion {
  const created =
    row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    assessmentVersionId: row.assessment_version_id,
    blueprintSequence: row.blueprint_sequence,
    questionType: row.question_type as GeneratedQuestion['questionType'],
    difficulty: row.difficulty as GeneratedQuestion['difficulty'],
    stem: row.stem,
    options: row.options as GeneratedQuestion['options'],
    answer: row.answer,
    explanation: row.explanation,
    sourceIds: row.source_ids as GeneratedQuestion['sourceIds'],
    versionMetadata: row.version_metadata as GeneratedQuestion['versionMetadata'],
    createdAt: created.toISOString(),
  };
}