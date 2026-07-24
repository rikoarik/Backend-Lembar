/**
 * AdminDataStore backed by jwt_users + spike_jobs (when present).
 */
import { desc, eq } from 'drizzle-orm';

import type { Database } from '../../../infrastructure/database/db.js';
import { getPool } from '../../../infrastructure/database/db.js';
import { jwtUsers } from '../../auth/persistence/jwtUsersSchema.js';
import type { AdminDataStore } from '../application/AdminService.js';
import type {
  AdminAccountSummary,
  AdminEntitlementInput,
  AdminJobSummary,
  AdminQualityReport,
} from '../domain/types.js';

export class PostgresAdminDataStore implements AdminDataStore {
  constructor(private readonly db: Database) {}

  async listAccounts(): Promise<AdminAccountSummary[]> {
    const rows = await this.db
      .select({
        id: jwtUsers.id,
        email: jwtUsers.email,
        roles: jwtUsers.roles,
        workspaceId: jwtUsers.workspaceId,
        createdAt: jwtUsers.createdAt,
      })
      .from(jwtUsers)
      .orderBy(desc(jwtUsers.createdAt));

    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: (r.roles[0] ?? 'subscriber') as AdminAccountSummary['role'],
      workspaceId: r.workspaceId ?? '',
      membershipState: 'active',
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async listJobs(limit = 100): Promise<AdminJobSummary[]> {
    const pool = getPool(this.db);
    if (!pool) return [];

    try {
      const result = await pool.query(
        `SELECT id, workspace_id, actor_id, kind, status, attempt, created_at
         FROM spike_jobs
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit],
      );

      return result.rows.map((row: Record<string, unknown>) => ({
        id: String(row['id']),
        workspaceId: String(row['workspace_id'] ?? ''),
        actorId: String(row['actor_id'] ?? ''),
        kind: String(row['kind'] ?? ''),
        status: String(row['status'] ?? ''),
        attempt: Number(row['attempt'] ?? 0),
        createdAt: new Date(String(row['created_at'])).toISOString(),
      }));
    } catch {
      return [];
    }
  }

  async listQualityReports(_limit = 100): Promise<AdminQualityReport[]> {
    // Quality reports table not yet wired — return empty for now.
    return [];
  }

  async setEntitlement(
    input: AdminEntitlementInput,
  ): Promise<{ workspaceId: string; plan: string }> {
    const pool = getPool(this.db);
    if (!pool) {
      return { workspaceId: input.workspaceId, plan: input.plan };
    }

    // Prefer workspace_plans if present; use tenant_id from jwt_users if available.
    try {
      const user = await this.db
        .select({ workspaceId: jwtUsers.workspaceId })
        .from(jwtUsers)
        .where(eq(jwtUsers.workspaceId, input.workspaceId))
        .limit(1);

      const tenantId = user[0]?.workspaceId ?? input.workspaceId;

      await pool.query(
        `INSERT INTO workspace_plans (tenant_id, workspace_id, plan, active)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (tenant_id, workspace_id)
         DO UPDATE SET plan = EXCLUDED.plan, updated_at = now()`,
        [tenantId, input.workspaceId, input.plan],
      );
    } catch {
      // best-effort
    }

    return { workspaceId: input.workspaceId, plan: input.plan };
  }
}
