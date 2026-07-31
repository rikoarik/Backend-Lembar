import { randomUUID } from 'node:crypto';
import { getPool, type Database } from '../../../infrastructure/database/db.js';
import type { ShareLink, ShareLinkStore } from '../domain/ShareLink.js';

interface ShareLinkRow {
  id: string;
  workspace_id: string;
  assessment_id: string;
  token: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

function rowToLink(row: ShareLinkRow): ShareLink {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    assessmentId: row.assessment_id,
    token: row.token,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export class PostgresShareLinkStore implements ShareLinkStore {
  constructor(private readonly db: Database) {}

  async save(link: ShareLink): Promise<ShareLink> {
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database not available');
    const { rows } = await pool.query<ShareLinkRow>(
      `INSERT INTO share_links (id, workspace_id, assessment_id, token, expires_at, revoked_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at
       RETURNING *`,
      [link.id, link.workspaceId, link.assessmentId, link.token, link.expiresAt, link.revokedAt, link.createdAt],
    );
    return rowToLink(rows[0]!);
  }

  async findByToken(token: string): Promise<ShareLink | null> {
    const pool = getPool(this.db);
    if (!pool) return null;
    const { rows } = await pool.query<ShareLinkRow>(
      `SELECT * FROM share_links WHERE token = $1 LIMIT 1`,
      [token],
    );
    return rows[0] ? rowToLink(rows[0]) : null;
  }

  async findByAssessment(workspaceId: string, assessmentId: string): Promise<ShareLink[]> {
    const pool = getPool(this.db);
    if (!pool) return [];
    const { rows } = await pool.query<ShareLinkRow>(
      `SELECT * FROM share_links WHERE workspace_id = $1 AND assessment_id = $2 ORDER BY created_at DESC`,
      [workspaceId, assessmentId],
    );
    return rows.map(rowToLink);
  }

  async revoke(token: string): Promise<ShareLink | null> {
    const pool = getPool(this.db);
    if (!pool) return null;
    const { rows } = await pool.query<ShareLinkRow>(
      `UPDATE share_links SET revoked_at = now() WHERE token = $1 RETURNING *`,
      [token],
    );
    return rows[0] ? rowToLink(rows[0]) : null;
  }

  async delete(id: string): Promise<void> {
    const pool = getPool(this.db);
    if (!pool) return;
    await pool.query(`DELETE FROM share_links WHERE id = $1`, [id]);
  }
}
