import { getPool, type Database } from '../../../infrastructure/database/db.js';

import type { RetrievedPassage, SourceRetrievalStore } from '../domain/SourceRetrieval.js';

/** Durable read model used by both API and worker when DATABASE_URL is configured. */
export class PostgresSourceRetrievalStore implements SourceRetrievalStore {
  constructor(private readonly db: Database) {}

  async listPassagesForUpload(
    workspaceId: string,
    uploadId: string,
    options: { limit?: number } = {},
  ): Promise<RetrievedPassage[]> {
    const pool = getPool(this.db);
    if (!pool) return [];
    const { rows } = await pool.query<PassageRow>(
      `SELECT id, upload_id, page_number, sequence, text_normalized, char_count, content_hash
       FROM source_passages
       WHERE workspace_id = $1::uuid AND upload_id = $2::uuid
       ORDER BY page_number, sequence LIMIT $3`,
      [workspaceId, uploadId, options.limit ?? 100],
    );
    return rows.map(mapPassage);
  }

  async listPassagesForUploads(
    workspaceId: string,
    uploadIds: string[],
    options: { limitPerUpload?: number } = {},
  ): Promise<Map<string, RetrievedPassage[]>> {
    const result = new Map<string, RetrievedPassage[]>();
    for (const uploadId of uploadIds) {
      result.set(
        uploadId,
        await this.listPassagesForUpload(
          workspaceId,
          uploadId,
          options.limitPerUpload === undefined ? undefined : { limit: options.limitPerUpload },
        ),
      );
    }
    return result;
  }

  async getPassageById(workspaceId: string, passageId: string): Promise<RetrievedPassage | null> {
    const pool = getPool(this.db);
    if (!pool) return null;
    const { rows } = await pool.query<PassageRow>(
      `SELECT id, upload_id, page_number, sequence, text_normalized, char_count, content_hash
       FROM source_passages WHERE workspace_id = $1::uuid AND id = $2::uuid LIMIT 1`,
      [workspaceId, passageId],
    );
    return rows[0] ? mapPassage(rows[0]) : null;
  }

  async getReadyUploadIds(workspaceId: string, uploadIds: string[]): Promise<string[]> {
    if (uploadIds.length === 0) return [];
    const pool = getPool(this.db);
    if (!pool) return [];
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM source_uploads
       WHERE workspace_id = $1::uuid AND status = 'verified' AND id = ANY($2::uuid[])`,
      [workspaceId, uploadIds],
    );
    const ready = new Set(rows.map((row) => row.id));
    return uploadIds.filter((id) => ready.has(id));
  }
}

interface PassageRow {
  id: string;
  upload_id: string;
  page_number: number;
  sequence: number;
  text_normalized: string;
  char_count: number;
  content_hash: string;
}

function mapPassage(row: PassageRow): RetrievedPassage {
  return {
    passageId: row.id,
    uploadId: row.upload_id,
    pageNumber: row.page_number,
    sequence: row.sequence,
    text: row.text_normalized,
    charCount: row.char_count,
    contentHash: row.content_hash,
  };
}
