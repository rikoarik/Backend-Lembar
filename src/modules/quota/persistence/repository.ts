/**
 * Quota reservation repository adapter.
 *
 * Handles database operations for quota reservations using Drizzle ORM.
 */
import { eq, and, sql } from 'drizzle-orm';

import type { Database } from '../../../infrastructure/database/db.js';
import { quotaReservations, type QuotaReservation, type NewQuotaReservation } from '../persistence/schema.js';
import type { QuotaBalance } from '../domain/types.js';

export class QuotaReservationRepository {
  constructor(private readonly db: Database) {}

  async insert(data: NewQuotaReservation): Promise<QuotaReservation> {
    const [row] = await this.db.insert(quotaReservations).values(data).returning();
    if (!row) throw new Error('Failed to insert quota reservation');
    return row;
  }

  async findById(id: string): Promise<QuotaReservation | null> {
    const [row] = await this.db
      .select()
      .from(quotaReservations)
      .where(eq(quotaReservations.id, id))
      .limit(1);
    return row ?? null;
  }

  async findByIdempotencyKey(
    tenantId: string,
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<QuotaReservation | null> {
    const [row] = await this.db
      .select()
      .from(quotaReservations)
      .where(
        and(
          eq(quotaReservations.tenantId, tenantId),
          eq(quotaReservations.workspaceId, workspaceId),
          eq(quotaReservations.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async commit(id: string): Promise<QuotaReservation | null> {
    const [row] = await this.db
      .update(quotaReservations)
      .set({
        state: 'committed',
        committedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(quotaReservations.id, id))
      .returning();
    return row ?? null;
  }

  async release(id: string): Promise<QuotaReservation | null> {
    const [row] = await this.db
      .update(quotaReservations)
      .set({
        state: 'released',
        releasedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(quotaReservations.id, id))
      .returning();
    return row ?? null;
  }

  async getBalance(tenantId: string, workspaceId: string): Promise<QuotaBalance> {
    const result = await this.db
      .select({
        state: quotaReservations.state,
        totalUnits: sql<number>`sum(${quotaReservations.units})::int`,
      })
      .from(quotaReservations)
      .where(
        and(
          eq(quotaReservations.tenantId, tenantId),
          eq(quotaReservations.workspaceId, workspaceId),
        ),
      )
      .groupBy(quotaReservations.state);

    let reserved = 0;
    let committed = 0;
    let released = 0;

    for (const row of result) {
      const units = row.totalUnits ?? 0;
      switch (row.state) {
        case 'reserved':
          reserved = units;
          break;
        case 'committed':
          committed = units;
          break;
        case 'released':
          released = units;
          break;
      }
    }

    return {
      tenantId,
      workspaceId,
      reserved,
      committed,
      released,
      available: reserved - committed - released,
    };
  }

  async findByJobId(jobId: string): Promise<QuotaReservation | null> {
    const [row] = await this.db
      .select()
      .from(quotaReservations)
      .where(eq(quotaReservations.jobId, jobId))
      .limit(1);
    return row ?? null;
  }
}
