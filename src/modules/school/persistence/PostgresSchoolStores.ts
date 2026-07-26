/**
 * Postgres-backed school workspace store.
 *
 * Implements SchoolWorkspaceStore interface using raw SQL queries
 * against tenants and jwt_users tables. Replaces the InMemory store
 * so dashboard/stats work for real (non-demo) workspaces.
 */
import { getPool, type Database } from '../../../infrastructure/database/db.js';

import type {
  SchoolWorkspace,
  SchoolMember,
} from '../domain/types.js';
import type { SchoolWorkspaceStore } from '../application/SchoolService.js';

export class PostgresSchoolWorkspaceStore implements SchoolWorkspaceStore {
  constructor(private readonly db: Database) {}

  async createWorkspace(
    tenantId: string,
    name: string,
    level: string,
  ): Promise<SchoolWorkspace> {
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database not available');

    const { rows } = await pool.query<{
      id: string;
      name: string;
      slug: string;
      created_at: Date;
    }>(
      `INSERT INTO tenants (id, name, slug, created_at)
       VALUES ($1::uuid, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, slug, created_at`,
      [tenantId, name, name.toLowerCase().replace(/\s+/g, '-')],
    );

    const row = rows[0]!;
    return {
      id: row.id,
      tenantId,
      name: row.name,
      level,
      createdAt: row.created_at.toISOString(),
    };
  }

  async getWorkspace(tenantId: string, workspaceId: string): Promise<SchoolWorkspace | null> {
    const pool = getPool(this.db);
    if (!pool) return null;

    // In this system, workspaceId == tenants.id (single-tenant per workspace)
    const { rows } = await pool.query<{
      id: string;
      name: string;
      created_at: Date;
    }>(
      `SELECT id, name, created_at
       FROM tenants
       WHERE id = $1::uuid
       LIMIT 1`,
      [workspaceId],
    );

    if (rows.length === 0) return null;

    const row = rows[0]!;
    // Determine level from schools table
    const schoolRes = await pool.query<{ level: string }>(
      `SELECT level FROM schools WHERE tenant_id = $1::uuid LIMIT 1`,
      [workspaceId],
    );
    const level = schoolRes.rows[0]?.level ?? 'unknown';

    return {
      id: row.id,
      tenantId,
      name: row.name,
      level,
      createdAt: row.created_at.toISOString(),
    };
  }

  async listMembers(tenantId: string, workspaceId: string): Promise<SchoolMember[]> {
    const pool = getPool(this.db);
    if (!pool) return [];

    const { rows } = await pool.query<{
      id: string;
      email: string;
      roles: string[];
      created_at: Date;
    }>(
      `SELECT id, email, roles, created_at
       FROM jwt_users
       WHERE workspace_id = $1::uuid
       ORDER BY created_at ASC`,
      [workspaceId],
    );

    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: (r.roles?.[0] ?? 'subscriber') as SchoolMember['role'],
      state: 'active',
      joinedAt: r.created_at.toISOString(),
    }));
  }

  async updateMemberRole(
    _tenantId: string,
    workspaceId: string,
    memberId: string,
    role: SchoolMember['role'],
  ): Promise<SchoolMember | null> {
    const pool = getPool(this.db);
    if (!pool) return null;

    const { rows } = await pool.query<{
      id: string;
      email: string;
      roles: string[];
    }>(
      `UPDATE jwt_users
       SET roles = ARRAY[$1]::text[], updated_at = now()
       WHERE id = $2::uuid AND workspace_id = $3::uuid
       RETURNING id, email, roles`,
      [role, memberId, workspaceId],
    );

    if (rows.length === 0) return null;

    const row = rows[0]!;
    return {
      id: row.id,
      email: row.email,
      role,
      state: 'active',
      joinedAt: new Date().toISOString(),
    };
  }

  async removeMember(
    _tenantId: string,
    workspaceId: string,
    memberId: string,
  ): Promise<boolean> {
    const pool = getPool(this.db);
    if (!pool) return false;

    const { rowCount } = await pool.query(
      `UPDATE jwt_users
       SET workspace_id = NULL, updated_at = now()
       WHERE id = $1::uuid AND workspace_id = $2::uuid`,
      [memberId, workspaceId],
    );

    return (rowCount ?? 0) > 0;
  }
}
