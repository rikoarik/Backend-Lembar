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
import type {
  SchoolWorkspaceStore,
  SchoolInvitationStore,
  SchoolInvitationRecord,
  NewInvitedUser,
} from '../application/SchoolService.js';
import { UsernameTakenError } from '../application/SchoolService.js';

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
export type QueryRunner = (text: string, values: unknown[]) => Promise<unknown>;

export class PostgresSchoolInvitationStore implements SchoolInvitationStore {
  /**
   * `queryOverride` lets `transaction()` re-point every statement at the
   * checked-out client without duplicating the SQL.
   */
  constructor(
    private readonly db: Database,
    private readonly queryOverride?: QueryRunner | undefined,
  ) {}

  private async run(text: string, values: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }> {
    if (this.queryOverride) {
      const result = (await this.queryOverride(text, values)) as {
        rows?: unknown[];
        rowCount?: number | null;
      };
      return { rows: result.rows ?? [], rowCount: result.rowCount ?? null };
    }
    const pool = getPool(this.db);
    if (!pool) return { rows: [], rowCount: null };
    return pool.query(text, values) as unknown as Promise<{
      rows: unknown[];
      rowCount?: number | null;
    }>;
  }

  async saveInvitation(record: {
    tokenHash: string;
    email: string;
    workspaceId: string;
    tenantId: string;
    role: string;
    state: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.run(
      `INSERT INTO auth_school_invitations
         (id, tenant_id, email, role, state, token_hash, expires_at, created_at)
       VALUES
         (gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, now())
       ON CONFLICT (token_hash)
       DO UPDATE SET state = EXCLUDED.state`,
      [
        record.tenantId,
        record.email,
        record.role,
        record.state,
        record.tokenHash,
        record.expiresAt,
      ],
    );
  }

  async findByTokenHash(tokenHash: string): Promise<SchoolInvitationRecord | null> {
    const { rows } = (await this.run(
      `SELECT token_hash, email, tenant_id AS workspace_id, tenant_id, role, state, expires_at
       FROM auth_school_invitations
       WHERE token_hash = $1
       LIMIT 1`,
      [tokenHash],
    )) as {
      rows: {
        token_hash: string;
        email: string;
        workspace_id: string;
        tenant_id: string;
        role: string;
        state: string;
        expires_at: Date;
      }[];
    };
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

  async markAccepted(tokenHash: string, userId: string): Promise<boolean> {
    // `state = 'pending'` guard makes this the one-time-use gate: a concurrent
    // or replayed accept updates 0 rows and is reported as already consumed.
    const { rowCount } = await this.run(
      `UPDATE auth_school_invitations
       SET state = 'accepted', accepted_by = $2::uuid
       WHERE token_hash = $1 AND state = 'pending'`,
      [tokenHash, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  async saveMember(_tenantId: string, workspaceId: string, member: SchoolMember): Promise<void> {
    // Members are stored on jwt_users itself; there is no separate members table
    // and workspace IS the tenant. `workspace_id` is what `listMembers()` filters
    // on, so it has to be set here or the accepted invitee stays invisible.
    // One workspace per user is the current model (see SchoolWorkspaceStore).
    await this.run(
      `UPDATE jwt_users
       SET workspace_id = $2::uuid,
           roles = array_append(array_remove(roles, $3::text), $3::text),
           updated_at = now()
       WHERE id = $1::uuid`,
      [member.id, workspaceId, member.role],
    );
  }

  async createUser(user: NewInvitedUser): Promise<{ id: string; email: string; username: string }> {
    try {
      // name / username / roles are NOT NULL on jwt_users — the whole point of
      // BUG-20b is that this INSERT used to omit them.
      await this.run(
        `INSERT INTO jwt_users (id, email, password_hash, name, username, roles, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::text[], now(), now())`,
        [user.id, user.email, user.passwordHash, user.name, user.username, user.roles],
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      const constraint = (error as { constraint?: string }).constraint ?? '';
      if (code === '23505' && constraint === 'jwt_users_username_unique') {
        throw new UsernameTakenError(`Username ${user.username} sudah dipakai`);
      }
      throw error;
    }
    return { id: user.id, email: user.email, username: user.username };
  }

  async getUserByEmail(
    email: string,
  ): Promise<{ id: string; email: string; passwordHash: string } | null> {
    const { rows } = (await this.run(
      `SELECT id, email, password_hash FROM jwt_users WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    )) as { rows: { id: string; email: string; password_hash: string }[] };
    if (rows.length === 0) return null;
    const row = rows[0]!;
    return { id: row.id, email: row.email, passwordHash: row.password_hash };
  }

  /**
   * Accept-invitation writes run on a single pooled client so the user insert,
   * the membership grant and the token burn commit or roll back together.
   * Without a pool (no DATABASE_URL) the callback still runs, unguarded.
   */
  async transaction<T>(fn: (store: SchoolInvitationStore) => Promise<T>): Promise<T> {
    const pool = getPool(this.db);
    if (!pool) return fn(this);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const scoped = new PostgresSchoolInvitationStore(this.db, (text, values) =>
        client.query(text, values),
      );
      const result = await fn(scoped);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
