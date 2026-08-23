import { getPool, type Database } from '../../../infrastructure/database/db.js';

import type {
  CreateExtractionJobInput,
  InsertPassageInput,
  SourceExtractionJob,
  SourceExtractionJobsStore,
  SourcePassage,
  SourcePassagesStore,
  UpdateExtractionJobInput,
} from '../domain/SourceExtraction.js';

export class PostgresSourceExtractionJobsStore implements SourceExtractionJobsStore {
  constructor(private readonly db: Database) {}

  async createJob(input: CreateExtractionJobInput): Promise<SourceExtractionJob> {
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database not available');

    const { rows } = await pool.query<ExtractionJobRow>(
      `INSERT INTO source_extraction_jobs (
        upload_id, workspace_id, status, stage, attempt, parser_version
      ) VALUES ($1::uuid, $2::uuid, 'pending', NULL, 0, $3)
      ON CONFLICT (upload_id) DO UPDATE SET
        updated_at = source_extraction_jobs.updated_at
      RETURNING *`,
      [input.uploadId, input.workspaceId, input.parserVersion ?? '1'],
    );

    return mapExtractionJob(rows[0]!);
  }

  async getJobByUploadId(
    workspaceId: string,
    uploadId: string,
  ): Promise<SourceExtractionJob | null> {
    const pool = getPool(this.db);
    if (!pool) return null;

    const { rows } = await pool.query<ExtractionJobRow>(
      `SELECT * FROM source_extraction_jobs
       WHERE workspace_id = $1::uuid AND upload_id = $2::uuid
       LIMIT 1`,
      [workspaceId, uploadId],
    );
    return rows[0] ? mapExtractionJob(rows[0]) : null;
  }

  async getJobById(id: string): Promise<SourceExtractionJob | null> {
    const pool = getPool(this.db);
    if (!pool) return null;

    const { rows } = await pool.query<ExtractionJobRow>(
      `SELECT * FROM source_extraction_jobs WHERE id = $1::uuid LIMIT 1`,
      [id],
    );
    return rows[0] ? mapExtractionJob(rows[0]) : null;
  }

  async updateJob(input: UpdateExtractionJobInput): Promise<SourceExtractionJob> {
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database not available');

    const sets = ['updated_at = now()'];
    const params: unknown[] = [input.id];
    let index = 2;

    if (input.status !== undefined) {
      sets.push(`status = $${index++}`);
      params.push(input.status);
    }
    if (input.stage !== undefined) {
      sets.push(`stage = $${index++}`);
      params.push(input.stage);
    }
    if (input.attempt !== undefined) {
      sets.push(`attempt = $${index++}`);
      params.push(input.attempt);
    }
    if (input.failureCode !== undefined) {
      sets.push(`failure_code = $${index++}`);
      params.push(input.failureCode);
    }
    if (input.pageCount !== undefined) {
      sets.push(`page_count = $${index++}`);
      params.push(input.pageCount);
    }
    if (input.passageCount !== undefined) {
      sets.push(`passage_count = $${index++}`);
      params.push(input.passageCount);
    }
    if (input.startedAt !== undefined) {
      sets.push(`started_at = $${index++}::timestamptz`);
      params.push(input.startedAt);
    }
    if (input.finishedAt !== undefined) {
      sets.push(`finished_at = $${index}::timestamptz`);
      params.push(input.finishedAt);
    }

    const { rows } = await pool.query<ExtractionJobRow>(
      `UPDATE source_extraction_jobs
       SET ${sets.join(', ')}
       WHERE id = $1::uuid
       RETURNING *`,
      params,
    );

    if (!rows[0]) throw new Error(`ExtractionJob not found: ${input.id}`);
    return mapExtractionJob(rows[0]);
  }
}

export class PostgresSourcePassagesStore implements SourcePassagesStore {
  constructor(private readonly db: Database) {}

  async insertPassage(input: InsertPassageInput): Promise<SourcePassage> {
    const passages = await this.insertPassages([input]);
    return passages[0]!;
  }

  async insertPassages(inputs: InsertPassageInput[]): Promise<SourcePassage[]> {
    if (inputs.length === 0) return [];

    const pool = getPool(this.db);
    if (!pool) throw new Error('Database not available');

    const params: unknown[] = [];
    const values = inputs.map((input, inputIndex) => {
      const base = inputIndex * 9;
      params.push(
        input.uploadId,
        input.workspaceId,
        input.extractionJobId,
        input.pageNumber,
        input.sequence,
        input.textNormalized,
        input.textNormalized.length,
        input.contentHash,
        input.parserVersion,
      );
      return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::uuid, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
    });

    const { rows } = await pool.query<PassageRow>(
      `INSERT INTO source_passages (
        upload_id, workspace_id, extraction_job_id, page_number, sequence,
        text_normalized, char_count, content_hash, parser_version
      ) VALUES ${values.join(', ')}
      ON CONFLICT (upload_id, page_number, sequence) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        extraction_job_id = EXCLUDED.extraction_job_id,
        text_normalized = EXCLUDED.text_normalized,
        char_count = EXCLUDED.char_count,
        content_hash = EXCLUDED.content_hash,
        parser_version = EXCLUDED.parser_version
      RETURNING *`,
      params,
    );

    return rows.map(mapPassage);
  }

  async listPassagesByUpload(
    workspaceId: string,
    uploadId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<SourcePassage[]> {
    const pool = getPool(this.db);
    if (!pool) return [];

    const { rows } = await pool.query<PassageRow>(
      `SELECT * FROM source_passages
       WHERE workspace_id = $1::uuid AND upload_id = $2::uuid
       ORDER BY page_number ASC, sequence ASC
       LIMIT $3 OFFSET $4`,
      [workspaceId, uploadId, options.limit ?? 100, options.offset ?? 0],
    );
    return rows.map(mapPassage);
  }

  async countPassagesByUpload(workspaceId: string, uploadId: string): Promise<number> {
    const pool = getPool(this.db);
    if (!pool) return 0;

    const { rows } = await pool.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM source_passages
       WHERE workspace_id = $1::uuid AND upload_id = $2::uuid`,
      [workspaceId, uploadId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async getPassageById(workspaceId: string, passageId: string): Promise<SourcePassage | null> {
    const pool = getPool(this.db);
    if (!pool) return null;
    const { rows } = await pool.query<PassageRow>(
      `SELECT * FROM source_passages WHERE workspace_id = $1::uuid AND id = $2::uuid LIMIT 1`,
      [workspaceId, passageId],
    );
    return rows[0] ? mapPassage(rows[0]) : null;
  }

  async deletePassagesByJob(extractionJobId: string): Promise<void> {
    const pool = getPool(this.db);
    if (!pool) return;

    await pool.query(`DELETE FROM source_passages WHERE extraction_job_id = $1::uuid`, [
      extractionJobId,
    ]);
  }
}

interface ExtractionJobRow {
  id: string;
  upload_id: string;
  workspace_id: string;
  status: SourceExtractionJob['status'];
  stage: SourceExtractionJob['stage'];
  attempt: number;
  failure_code: string | null;
  parser_version: string;
  page_count: number | null;
  passage_count: number | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PassageRow {
  id: string;
  upload_id: string;
  workspace_id: string;
  extraction_job_id: string;
  page_number: number;
  sequence: number;
  text_normalized: string;
  char_count: number;
  content_hash: string;
  parser_version: string;
  created_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapExtractionJob(row: ExtractionJobRow): SourceExtractionJob {
  return {
    id: row.id,
    uploadId: row.upload_id,
    workspaceId: row.workspace_id,
    status: row.status,
    stage: row.stage,
    attempt: row.attempt,
    failureCode: row.failure_code,
    parserVersion: row.parser_version,
    pageCount: row.page_count,
    passageCount: row.passage_count,
    startedAt: row.started_at == null ? null : iso(row.started_at),
    finishedAt: row.finished_at == null ? null : iso(row.finished_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapPassage(row: PassageRow): SourcePassage {
  return {
    id: row.id,
    uploadId: row.upload_id,
    workspaceId: row.workspace_id,
    extractionJobId: row.extraction_job_id,
    pageNumber: row.page_number,
    sequence: row.sequence,
    textNormalized: row.text_normalized,
    charCount: row.char_count,
    contentHash: row.content_hash,
    parserVersion: row.parser_version,
    createdAt: iso(row.created_at),
  };
}
