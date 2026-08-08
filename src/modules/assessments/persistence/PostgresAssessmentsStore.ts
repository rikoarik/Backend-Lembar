import { randomUUID } from 'node:crypto';

import { getPool, type Database } from '../../../infrastructure/database/db.js';

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

export class PostgresAssessmentsStore implements AssessmentsStore {
  constructor(private readonly db: Database) {}

  async createAssessment(input: CreateAssessmentInput): Promise<Assessment> {
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database not available');

    const id = randomUUID();
    const { rows } = await pool.query<AssessmentRow>(
      `INSERT INTO assessments (
        id, workspace_id, creator_user_id, title, status, current_version, idempotency_key, created_at, updated_at
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'draft', 0, $5, now(), now())
      RETURNING *`,
      [id, input.workspaceId, input.creatorUserId, input.title, input.idempotencyKey ?? null],
    );

    return mapAssessment(rows[0]!);
  }

  async getAssessmentById(workspaceId: string, id: string): Promise<Assessment | null> {
    const pool = getPool(this.db);
    if (!pool) return null;

    const { rows } = await pool.query<AssessmentRow>(
      `SELECT * FROM assessments WHERE workspace_id = $1::uuid AND id = $2::uuid LIMIT 1`,
      [workspaceId, id],
    );
    return rows[0] ? mapAssessment(rows[0]) : null;
  }

  async getAssessmentByIdempotencyKey(
    workspaceId: string,
    key: string,
  ): Promise<Assessment | null> {
    const pool = getPool(this.db);
    if (!pool) return null;

    const { rows } = await pool.query<AssessmentRow>(
      `SELECT * FROM assessments WHERE workspace_id = $1::uuid AND idempotency_key = $2 LIMIT 1`,
      [workspaceId, key],
    );
    return rows[0] ? mapAssessment(rows[0]) : null;
  }

  async listAssessments(
    workspaceId: string,
    options: { limit: number; cursor?: string },
  ): Promise<Assessment[]> {
    const pool = getPool(this.db);
    if (!pool) return [];

    const cursorCreatedAt = options.cursor
      ? await pool.query<{ created_at: Date }>(
          `SELECT created_at FROM assessments WHERE workspace_id = $1::uuid AND id = $2::uuid LIMIT 1`,
          [workspaceId, options.cursor],
        )
      : null;

    const params: unknown[] = [workspaceId, options.limit];
    let where = `workspace_id = $1::uuid`;
    if (options.cursor && cursorCreatedAt?.rows[0]) {
      params.push(cursorCreatedAt.rows[0].created_at, options.cursor);
      where += ` AND (created_at, id) < ($3::timestamptz, $4::uuid)`;
    }

    const { rows } = await pool.query<AssessmentRow>(
      `SELECT * FROM assessments
       WHERE ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      params,
    );

    return rows.map(mapAssessment);
  }

  async updateAssessment(input: UpdateAssessmentInput): Promise<Assessment> {
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database not available');

    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [input.id, input.workspaceId];
    let i = 3;

    if (input.status !== undefined) {
      sets.push(`status = $${i++}`);
      params.push(input.status);
    }
    if (input.currentVersion !== undefined) {
      sets.push(`current_version = $${i++}`);
      params.push(input.currentVersion);
    }
    if (input.title !== undefined) {
      sets.push(`title = $${i++}`);
      params.push(input.title);
    }

    const { rows } = await pool.query<AssessmentRow>(
      `UPDATE assessments
       SET ${sets.join(', ')}
       WHERE id = $1::uuid AND workspace_id = $2::uuid
       RETURNING *`,
      params,
    );

    if (!rows[0]) throw new Error(`Assessment not found: ${input.id}`);
    return mapAssessment(rows[0]);
  }

  async createAssessmentVersion(input: CreateAssessmentVersionInput): Promise<AssessmentVersion> {
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database not available');

    const id = randomUUID();
    const { rows } = await pool.query<AssessmentVersionRow>(
      `INSERT INTO assessment_versions (
        id, assessment_id, workspace_id, version, status, config_snapshot, schema_version, created_at
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'draft', $5::jsonb, '1', now())
      RETURNING *`,
      [id, input.assessmentId, input.workspaceId, input.version, JSON.stringify(input.configSnapshot)],
    );

    return mapAssessmentVersion(rows[0]!);
  }

  async getLatestVersion(
    workspaceId: string,
    assessmentId: string,
  ): Promise<AssessmentVersion | null> {
    const pool = getPool(this.db);
    if (!pool) return null;

    const { rows } = await pool.query<AssessmentVersionRow>(
      `SELECT * FROM assessment_versions
       WHERE workspace_id = $1::uuid AND assessment_id = $2::uuid
       ORDER BY version DESC
       LIMIT 1`,
      [workspaceId, assessmentId],
    );
    return rows[0] ? mapAssessmentVersion(rows[0]) : null;
  }

  async getVersionByNumber(
    workspaceId: string,
    assessmentId: string,
    version: number,
  ): Promise<AssessmentVersion | null> {
    const pool = getPool(this.db);
    if (!pool) return null;

    const { rows } = await pool.query<AssessmentVersionRow>(
      `SELECT * FROM assessment_versions
       WHERE workspace_id = $1::uuid AND assessment_id = $2::uuid AND version = $3
       LIMIT 1`,
      [workspaceId, assessmentId, version],
    );
    return rows[0] ? mapAssessmentVersion(rows[0]) : null;
  }

  async getVersionById(workspaceId: string, versionId: string): Promise<AssessmentVersion | null> {
    const pool = getPool(this.db);
    if (!pool) return null;

    const { rows } = await pool.query<AssessmentVersionRow>(
      `SELECT * FROM assessment_versions WHERE workspace_id = $1::uuid AND id = $2::uuid LIMIT 1`,
      [workspaceId, versionId],
    );
    return rows[0] ? mapAssessmentVersion(rows[0]) : null;
  }

  async createBlueprintItems(inputs: CreateBlueprintItemInput[]): Promise<BlueprintItem[]> {
    if (inputs.length === 0) return [];
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database not available');

    const values: string[] = [];
    const params: unknown[] = [];
    for (const [index, input] of inputs.entries()) {
      const base = index * 13;
      params.push(
        randomUUID(),
        input.assessmentVersionId,
        input.workspaceId,
        input.sequence,
        input.curriculumVersionId ?? null,
        input.outcomeId ?? null,
        input.subjectId ?? null,
        input.gradeId ?? null,
        input.questionType,
        input.difficulty,
        input.cognitiveLevel ?? null,
        input.topicHint ?? null,
        input.sourceUploadId ?? null,
      )
      values.push(
        `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::uuid, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}::uuid, now())`,
      )
    }

    const { rows } = await pool.query<BlueprintItemRow>(
      `INSERT INTO blueprint_items (
        id, assessment_version_id, workspace_id, sequence, curriculum_version_id,
        outcome_id, subject_id, grade_id, question_type, difficulty,
        cognitive_level, topic_hint, source_upload_id, created_at
      ) VALUES ${values.join(', ')}
      RETURNING *`,
      params,
    );

    return rows.map(mapBlueprintItem);
  }

  async listBlueprintItems(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<BlueprintItem[]> {
    const pool = getPool(this.db);
    if (!pool) return [];

    const { rows } = await pool.query<BlueprintItemRow>(
      `SELECT * FROM blueprint_items
       WHERE workspace_id = $1::uuid AND assessment_version_id = $2::uuid
       ORDER BY sequence ASC`,
      [workspaceId, assessmentVersionId],
    );
    return rows.map(mapBlueprintItem);
  }
}

interface AssessmentRow {
  id: string;
  workspace_id: string;
  creator_user_id: string;
  title: string;
  status: Assessment['status'];
  current_version: number;
  idempotency_key: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AssessmentVersionRow {
  id: string;
  assessment_id: string;
  workspace_id: string;
  version: number;
  status: AssessmentVersion['status'];
  config_snapshot: AssessmentVersion['configSnapshot'];
  schema_version: string;
  created_at: Date | string;
}

interface BlueprintItemRow {
  id: string;
  assessment_version_id: string;
  workspace_id: string;
  sequence: number;
  curriculum_version_id: string | null;
  outcome_id: string | null;
  subject_id: string | null;
  grade_id: string | null;
  question_type: BlueprintItem['questionType'];
  difficulty: BlueprintItem['difficulty'];
  cognitive_level: string | null;
  topic_hint: string | null;
  source_upload_id: string | null;
  created_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapAssessment(row: AssessmentRow): Assessment {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    creatorUserId: row.creator_user_id,
    title: row.title,
    status: row.status,
    currentVersion: row.current_version,
    idempotencyKey: row.idempotency_key,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapAssessmentVersion(row: AssessmentVersionRow): AssessmentVersion {
  return {
    id: row.id,
    assessmentId: row.assessment_id,
    workspaceId: row.workspace_id,
    version: row.version,
    status: row.status,
    configSnapshot: row.config_snapshot,
    schemaVersion: row.schema_version,
    createdAt: iso(row.created_at),
  };
}

function mapBlueprintItem(row: BlueprintItemRow): BlueprintItem {
  return {
    id: row.id,
    assessmentVersionId: row.assessment_version_id,
    workspaceId: row.workspace_id,
    sequence: row.sequence,
    curriculumVersionId: row.curriculum_version_id,
    outcomeId: row.outcome_id,
    subjectId: row.subject_id,
    gradeId: row.grade_id,
    questionType: row.question_type,
    difficulty: row.difficulty,
    cognitiveLevel: row.cognitive_level,
    topicHint: row.topic_hint,
    sourceUploadId: row.source_upload_id,
    createdAt: iso(row.created_at),
  };
}
