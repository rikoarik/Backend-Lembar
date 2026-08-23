import { getPool, type Database } from '../../../infrastructure/database/db.js';

import type {
  AssessmentFinalization,
  QuestionAuditEntry,
  QuestionReviewStore,
  ReviewedQuestion,
} from '../domain/QuestionReview.js';

export class PostgresQuestionReviewStore implements QuestionReviewStore {
  constructor(private readonly db: Database) {}

  async save(question: ReviewedQuestion): Promise<ReviewedQuestion> {
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database not available');

    const { rows } = await pool.query<ReviewedQuestionRow>(
      `INSERT INTO reviewed_questions (
        id, original_question_id, assessment_version_id, workspace_id, blueprint_sequence,
        question_type, difficulty, stem, options, answer, explanation, source_ids, image,
        status, version, etag, candidate_id, is_finalized, created_at, updated_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
        $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13::jsonb,
        $14, $15, $16, $17::uuid, $18, $19::timestamptz, $20::timestamptz
      )
      ON CONFLICT (id) DO UPDATE SET
        original_question_id = EXCLUDED.original_question_id,
        assessment_version_id = EXCLUDED.assessment_version_id,
        workspace_id = EXCLUDED.workspace_id,
        blueprint_sequence = EXCLUDED.blueprint_sequence,
        question_type = EXCLUDED.question_type,
        difficulty = EXCLUDED.difficulty,
        stem = EXCLUDED.stem,
        options = EXCLUDED.options,
        answer = EXCLUDED.answer,
        explanation = EXCLUDED.explanation,
        source_ids = EXCLUDED.source_ids,
        image = EXCLUDED.image,
        status = EXCLUDED.status,
        version = EXCLUDED.version,
        etag = EXCLUDED.etag,
        candidate_id = EXCLUDED.candidate_id,
        is_finalized = EXCLUDED.is_finalized,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at
      RETURNING *`,
      [
        question.id,
        question.originalQuestionId,
        question.assessmentVersionId,
        question.workspaceId,
        question.blueprintSequence,
        question.questionType,
        question.difficulty,
        question.stem,
        JSON.stringify(question.options),
        question.answer,
        question.explanation,
        JSON.stringify(question.sourceIds),
        question.image === undefined ? null : JSON.stringify(question.image),
        question.status,
        question.version,
        question.etag,
        question.candidateId,
        question.isFinalized,
        question.createdAt,
        question.updatedAt,
      ],
    );

    return mapReviewedQuestion(rows[0]!);
  }

  async findById(workspaceId: string, id: string): Promise<ReviewedQuestion | null> {
    const pool = getPool(this.db);
    if (!pool) return null;

    const { rows } = await pool.query<ReviewedQuestionRow>(
      `SELECT * FROM reviewed_questions WHERE workspace_id = $1::uuid AND id = $2::uuid LIMIT 1`,
      [workspaceId, id],
    );
    return rows[0] ? mapReviewedQuestion(rows[0]) : null;
  }

  async findByOriginalId(
    workspaceId: string,
    originalQuestionId: string,
  ): Promise<ReviewedQuestion | null> {
    const pool = getPool(this.db);
    if (!pool) return null;

    const { rows } = await pool.query<ReviewedQuestionRow>(
      `SELECT * FROM reviewed_questions
       WHERE workspace_id = $1::uuid AND original_question_id = $2::uuid AND candidate_id IS NULL
       LIMIT 1`,
      [workspaceId, originalQuestionId],
    );
    return rows[0] ? mapReviewedQuestion(rows[0]) : null;
  }

  async listByAssessmentVersion(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<ReviewedQuestion[]> {
    const pool = getPool(this.db);
    if (!pool) return [];

    const { rows } = await pool.query<ReviewedQuestionRow>(
      `SELECT rq.*
       FROM reviewed_questions rq
       WHERE rq.workspace_id = $1::uuid
         AND rq.assessment_version_id = $2::uuid
         AND NOT EXISTS (
           SELECT 1 FROM reviewed_questions parent
           WHERE parent.workspace_id = rq.workspace_id AND parent.candidate_id = rq.id
         )
       ORDER BY rq.blueprint_sequence ASC`,
      [workspaceId, assessmentVersionId],
    );
    return rows.map(mapReviewedQuestion);
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    const pool = getPool(this.db);
    if (!pool) return;
    await pool.query(`DELETE FROM reviewed_questions WHERE workspace_id = $1::uuid AND id = $2::uuid`, [workspaceId, id]);
  }

  async appendAudit(entry: QuestionAuditEntry): Promise<QuestionAuditEntry> {
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database not available');

    const { rows } = await pool.query<QuestionAuditRow>(
      `INSERT INTO question_audit_log (
        id, reviewed_question_id, assessment_version_id, workspace_id,
        action, previous_snapshot, next_snapshot, actor_user_id, created_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid,
        $5, $6::jsonb, $7::jsonb, $8::uuid, $9::timestamptz
      )
      RETURNING *`,
      [
        entry.id,
        entry.reviewedQuestionId,
        entry.assessmentVersionId,
        entry.workspaceId,
        entry.action,
        entry.previousSnapshot ? JSON.stringify(entry.previousSnapshot) : null,
        entry.nextSnapshot ? JSON.stringify(entry.nextSnapshot) : null,
        entry.actorUserId,
        entry.createdAt,
      ],
    );

    return mapAuditEntry(rows[0]!);
  }

  async getAuditLog(
    workspaceId: string,
    reviewedQuestionId: string,
  ): Promise<QuestionAuditEntry[]> {
    const pool = getPool(this.db);
    if (!pool) return [];

    const { rows } = await pool.query<QuestionAuditRow>(
      `SELECT * FROM question_audit_log
       WHERE workspace_id = $1::uuid AND reviewed_question_id = $2::uuid
       ORDER BY created_at ASC`,
      [workspaceId, reviewedQuestionId],
    );
    return rows.map(mapAuditEntry);
  }

  async getAssessmentAuditLog(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<QuestionAuditEntry[]> {
    const pool = getPool(this.db);
    if (!pool) return [];

    const { rows } = await pool.query<QuestionAuditRow>(
      `SELECT * FROM question_audit_log
       WHERE workspace_id = $1::uuid AND assessment_version_id = $2::uuid
       ORDER BY created_at ASC`,
      [workspaceId, assessmentVersionId],
    );
    return rows.map(mapAuditEntry);
  }

  async saveFinalization(record: AssessmentFinalization): Promise<AssessmentFinalization> {
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database not available');

    const { rows } = await pool.query<AssessmentFinalizationRow>(
      `INSERT INTO assessment_finalization (
        id, assessment_version_id, workspace_id, finalized_by, finalized_at
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz)
      ON CONFLICT (assessment_version_id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        finalized_by = EXCLUDED.finalized_by,
        finalized_at = EXCLUDED.finalized_at
      RETURNING *`,
      [
        record.id,
        record.assessmentVersionId,
        record.workspaceId,
        record.finalizedBy,
        record.finalizedAt,
      ],
    );

    return mapFinalization(rows[0]!);
  }

  async getFinalization(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<AssessmentFinalization | null> {
    const pool = getPool(this.db);
    if (!pool) return null;

    const { rows } = await pool.query<AssessmentFinalizationRow>(
      `SELECT * FROM assessment_finalization
       WHERE workspace_id = $1::uuid AND assessment_version_id = $2::uuid
       LIMIT 1`,
      [workspaceId, assessmentVersionId],
    );
    return rows[0] ? mapFinalization(rows[0]) : null;
  }

  async markAllFinalized(workspaceId: string, assessmentVersionId: string): Promise<void> {
    const pool = getPool(this.db);
    if (!pool) return;
    await pool.query(
      `UPDATE reviewed_questions
       SET is_finalized = true
       WHERE workspace_id = $1::uuid AND assessment_version_id = $2::uuid`,
      [workspaceId, assessmentVersionId],
    );
  }
}

interface ReviewedQuestionRow {
  id: string;
  original_question_id: string;
  assessment_version_id: string;
  workspace_id: string;
  blueprint_sequence: number;
  question_type: ReviewedQuestion['questionType'];
  difficulty: ReviewedQuestion['difficulty'];
  stem: string;
  options: ReviewedQuestion['options'];
  answer: string;
  explanation: string;
  source_ids: string[];
  image: ReviewedQuestion['image'] | null;
  status: ReviewedQuestion['status'];
  version: number;
  etag: string;
  candidate_id: string | null;
  is_finalized: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface QuestionAuditRow {
  id: string;
  reviewed_question_id: string;
  assessment_version_id: string;
  workspace_id: string;
  action: QuestionAuditEntry['action'];
  previous_snapshot: ReviewedQuestion | null;
  next_snapshot: ReviewedQuestion | null;
  actor_user_id: string;
  created_at: Date | string;
}

interface AssessmentFinalizationRow {
  id: string;
  assessment_version_id: string;
  workspace_id: string;
  finalized_by: string;
  finalized_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapReviewedQuestion(row: ReviewedQuestionRow): ReviewedQuestion {
  return {
    id: row.id,
    originalQuestionId: row.original_question_id,
    assessmentVersionId: row.assessment_version_id,
    workspaceId: row.workspace_id,
    blueprintSequence: row.blueprint_sequence,
    questionType: row.question_type,
    difficulty: row.difficulty,
    stem: row.stem,
    options: row.options.map((option) => ({ ...option })),
    answer: row.answer,
    explanation: row.explanation,
    sourceIds: [...row.source_ids],
    ...(row.image != null ? { image: { ...row.image } } : {}),
    status: row.status,
    version: row.version,
    etag: row.etag,
    candidateId: row.candidate_id,
    isFinalized: row.is_finalized,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapAuditEntry(row: QuestionAuditRow): QuestionAuditEntry {
  return {
    id: row.id,
    reviewedQuestionId: row.reviewed_question_id,
    assessmentVersionId: row.assessment_version_id,
    workspaceId: row.workspace_id,
    action: row.action,
    previousSnapshot: row.previous_snapshot,
    nextSnapshot: row.next_snapshot,
    actorUserId: row.actor_user_id,
    createdAt: iso(row.created_at),
  };
}

function mapFinalization(row: AssessmentFinalizationRow): AssessmentFinalization {
  return {
    id: row.id,
    assessmentVersionId: row.assessment_version_id,
    workspaceId: row.workspace_id,
    finalizedBy: row.finalized_by,
    finalizedAt: iso(row.finalized_at),
  };
}
