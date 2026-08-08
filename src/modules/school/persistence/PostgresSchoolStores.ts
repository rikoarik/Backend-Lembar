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
import type { SchoolWorkspaceStore, SchoolInvitationStore } from '../application/SchoolService.js';

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
export class PostgresSchoolInvitationStore implements SchoolInvitationStore {
  constructor(private readonly db: Database) {}

  async saveInvitation(record: {
    tokenHash: string;
    email: string;
    workspaceId: string;
    tenantId: string;
    role: string;
    state: string;
    expiresAt: Date;
  }): Promise<void> {
    const pool = getPool(this.db);
    if (!pool) return;
    await pool.query(
      `INSERT INTO auth_school_invitations
         (id, tenant_id, email, role, state, token_hash, workspace_id, expires_at, created_at)
       VALUES
         (gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6::uuid, $7, now())
       ON CONFLICT (token_hash)
       DO UPDATE SET state = EXCLUDED.state`,
      [
        record.tenantId,
        record.email,
        record.role,
        record.state,
        record.tokenHash,
        record.workspaceId,
        record.expiresAt,
      ],
    );
  }

  async findByTokenHash(tokenHash: string): Promise<{
    tokenHash: string;
    email: string;
    workspaceId: string;
    tenantId: string;
    role: string;
    state: string;
    expiresAt: Date;
  } | null> {
    const pool = getPool(this.db);
    if (!pool) return null;
    const { rows } = await pool.query<{
      token_hash: string;
      email: string;
      workspace_id: string;
      tenant_id: string;
      role: string;
      state: string;
      expires_at: Date;
    }>(
      `SELECT token_hash, email, workspace_id, tenant_id, role, state, expires_at
       FROM auth_school_invitations
       WHERE token_hash = $1
       LIMIT 1`,
      [tokenHash],
    );
    if (rows.length === 0) return null;
    const row = rows[0]!;
    return {
      tokenHash: row.token_hash,
      email: row.email,
      workspaceId: row.workspace_id,
      tenantId: row.tenant_id,
      role: row.role,
      state: row.state,
      expiresAt: row.expires_at,
    };
  }

  async markAccepted(tokenHash: string, _userId: string): Promise<void> {
    const pool = getPool(this.db);
    if (!pool) return;
    await pool.query(
      `UPDATE auth_school_invitations SET state = 'accepted' WHERE token_hash = $1`,
      [tokenHash],
    );
  }

  async saveMember(tenantId: string, _workspaceId: string, member: SchoolMember): Promise<void> {
    const pool = getPool(this.db);
    if (!pool) return;
    // Members are stored in jwt_users.roles; no separate members table — workspace IS the tenant.
    // Update roles array to include the new role if user exists.
    await pool.query(
      `UPDATE jwt_users
       SET roles = array_append(array_remove(roles, $2::text), $2::text),
           updated_at = now()
       WHERE id = $1::uuid`,
      [member.id, member.role],
    );
    void tenantId;
  }

  async saveUser(
    id: string,
    email: string,
    passwordHash: string,
  ): Promise<{ id: string; email: string }> {
    const pool = getPool(this.db);
    if (!pool) return { id, email };
    await pool.query(
      `INSERT INTO jwt_users (id, email, password_hash, created_at)
       VALUES ($1::uuid, $2, $3, now())
       ON CONFLICT (email) DO NOTHING`,
      [id, email, passwordHash],
    );
    return { id, email };
  }

  async getUserByEmail(
    email: string,
  ): Promise<{ id: string; email: string; passwordHash: string } | null> {
    const pool = getPool(this.db);
    if (!pool) return null;
    const { rows } = await pool.query<{
      id: string;
      email: string;
      password_hash: string;
    }>(
      `SELECT id, email, password_hash FROM jwt_users WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    );
    if (rows.length === 0) return null;
    const row = rows[0]!;
    return { id: row.id, email: row.email, passwordHash: row.password_hash };
  }
}
