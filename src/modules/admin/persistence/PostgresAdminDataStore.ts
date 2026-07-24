/**
 * AdminDataStore — queries for all admin ops.
 * Returns data shapes matching FE expectations.
 */
import { desc, eq } from 'drizzle-orm';

import type { Database } from '../../../infrastructure/database/db.js';
import { getPool } from '../../../infrastructure/database/db.js';
import { jwtUsers } from '../../auth/persistence/jwtUsersSchema.js';
import { tenants } from '../../../infrastructure/database/schema.js';
import type { AdminDataStore } from '../application/AdminService.js';
import type {
  AdminAccountSummary,
  AdminEntitlementInput,
  AdminJobSummary,
  AdminQualityReport,
} from '../domain/types.js';

export class PostgresAdminDataStore implements AdminDataStore {
  constructor(private readonly db: Database) {}

  // ── Accounts ────────────────────────────────────────
  async listAccounts(): Promise<AdminAccountSummary[]> {
    const pool = getPool(this.db);
    if (!pool) return [];

    const result = await pool.query(`
      SELECT
        jw.id, jw.email, jw.name, jw.username,
        jw.roles,
        jw.workspace_id,
        t.name as school_name,
        jw.created_at,
        CASE
          WHEN ab.state = 'blocked' THEN 'ditangguhkan'
          WHEN jw.created_at > now() - interval '7 days' THEN 'baru'
          ELSE 'aktif'
        END as status
      FROM jwt_users jw
      LEFT JOIN tenants t ON t.id = jw.workspace_id
      LEFT JOIN admin_billing ab ON ab.tenant_id = jw.workspace_id::text
      ORDER BY jw.created_at DESC
    `);

    return result.rows.map((r: any) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      displayName: r.name || r.username || r.email,
      role: (r.roles?.[0] ?? 'subscriber') as AdminAccountSummary['role'],
      status: r.status as AdminAccountSummary['status'],
      school: r.school_name ?? '—',
      workspaceId: r.workspace_id ?? '',
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  // ── Jobs ────────────────────────────────────────────
  async listJobs(limit = 100): Promise<AdminJobSummary[]> {
    const pool = getPool(this.db);
    if (!pool) return [];

    try {
      const result = await pool.query(
        `SELECT
          sj.id,
          sj.kind as type,
          COALESCE(t.name, sj.workspace_id, 'Platform') as tenant,
          sj.status,
          CASE
            WHEN sj.status = 'succeeded' THEN '100%'
            WHEN sj.status = 'running' THEN 'running'
            WHEN sj.status = 'failed' THEN 'failed'
            WHEN sj.status = 'queued' THEN '0%'
            ELSE 'pending'
          END as progress,
          sj.updated_at,
          sj.created_at
        FROM spike_jobs sj
        LEFT JOIN tenants t ON t.id = sj.workspace_id
        ORDER BY sj.updated_at DESC NULLS LAST, sj.created_at DESC
        LIMIT $1`,
        [limit],
      );

      return result.rows.map((r: any) => ({
        id: String(r.id),
        type: String(r.type ?? ''),
        tenant: String(r.tenant ?? 'Platform'),
        status: String(r.status ?? '') as AdminJobSummary['status'],
        progress: String(r.progress ?? ''),
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : (r.created_at ? new Date(r.created_at).toISOString() : ''),
      }));
    } catch {
      return [];
    }
  }

  // ── Quality Reports ────────────────────────────────
  async listQualityReports(limit = 100): Promise<AdminQualityReport[]> {
    const pool = getPool(this.db);
    if (!pool) return [];

    try {
      const result = await pool.query(
        `SELECT id, reason, status, reporter, notes, created_at
         FROM admin_quality_reports
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit],
      );

      return result.rows.map((r: any) => ({
        id: r.id,
        reason: r.reason,
        status: r.status,
        reporter: r.reporter,
        notes: r.notes ?? '',
        createdAt: new Date(r.created_at).toISOString(),
      }));
    } catch {
      return [];
    }
  }

  // ── Entitlements ────────────────────────────────────
  async setEntitlement(
    input: AdminEntitlementInput,
  ): Promise<{ workspaceId: string; plan: string }> {
    const pool = getPool(this.db);
    if (!pool) {
      return { workspaceId: input.workspaceId, plan: input.plan };
    }

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
