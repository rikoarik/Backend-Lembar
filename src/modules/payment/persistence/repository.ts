/**
 * Payment repository (B6-02).
 *
 * Idempotent upsert semantics for orders — same idempotency key always returns
 * the same order without creating a duplicate.
 */
import { and, eq, desc } from 'drizzle-orm';

import type { Database } from '../../../infrastructure/database/db.js';
import { paymentOrders, paymentEvents } from './schema.js';
import type {
  PaymentOrderRow,
  NewPaymentOrderRow,
  PaymentEventRow,
  NewPaymentEventRow,
} from './schema.js';
import type { PaymentOrderStatus } from '../domain/types.js';

export class PaymentRepository {
  constructor(private readonly db: Database) {}

  /**
   * Run payment and entitlement writes on one Drizzle transaction. Callers that
   * also modify workspace plans can use the provided transaction handle to
   * construct a transaction-bound WorkspacePlanRepository.
   */
  async transaction<T>(
    fn: (repo: PaymentRepository, db: Database) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => fn(new PaymentRepository(tx as Database), tx as Database));
  }

  // ── Orders ────────────────────────────────────────────────────────────────

  /**
   * Find an order by idempotency key. Returns null if not found.
   */
  async findByIdempotencyKey(key: string): Promise<PaymentOrderRow | null> {
    const rows = await this.db
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.idempotencyKey, key))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Find an order by its internal id.
   */
  async findById(id: string): Promise<PaymentOrderRow | null> {
    const rows = await this.db
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Find an order by the gateway's external order id.
   */
  async findByExternalOrderId(externalOrderId: string): Promise<PaymentOrderRow | null> {
    const rows = await this.db
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.externalOrderId, externalOrderId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * List all orders for a workspace, newest first.
   */
  async listByWorkspace(tenantId: string, workspaceId: string): Promise<PaymentOrderRow[]> {
    return this.db
      .select()
      .from(paymentOrders)
      .where(and(eq(paymentOrders.tenantId, tenantId), eq(paymentOrders.workspaceId, workspaceId)))
      .orderBy(desc(paymentOrders.createdAt));
  }

  /**
   * Insert an order once at the database uniqueness boundary.  The caller must
   * compare an existing row's immutable request fields before treating it as a
   * valid idempotent replay.
   */
  async createOrderIfAbsent(
    data: NewPaymentOrderRow,
  ): Promise<{ row: PaymentOrderRow; created: boolean }> {
    const inserted = await this.db
      .insert(paymentOrders)
      .values(data)
      .onConflictDoNothing({ target: paymentOrders.idempotencyKey })
      .returning();
    if (inserted[0]) return { row: inserted[0], created: true };

    const existing = await this.findByIdempotencyKey(data.idempotencyKey);
    if (!existing) throw new Error('Idempotency conflict without an existing payment order');
    return { row: existing, created: false };
  }

  /**
   * Compare-and-set status transition. Only one concurrent webhook observing
   * the same old status can win and perform payment side effects.
   */
  async transitionOrderIfCurrent(
    id: string,
    expectedStatus: PaymentOrderStatus,
    status: PaymentOrderStatus,
    opts?: {
      paidAt?: Date;
      gatewayPayload?: Record<string, unknown>;
      externalOrderId?: string;
    },
  ): Promise<PaymentOrderRow | null> {
    const now = new Date();
    // Drizzle's conditional optional object properties conflict with
    // exactOptionalPropertyTypes, so build the update object incrementally.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: Record<string, any> = { status, updatedAt: now };
    if (opts?.paidAt !== undefined) updates['paidAt'] = opts.paidAt;
    if (opts?.gatewayPayload !== undefined) updates['gatewayPayload'] = opts.gatewayPayload;
    if (opts?.externalOrderId !== undefined) updates['externalOrderId'] = opts.externalOrderId;

    const rows = await this.db
      .update(paymentOrders)
      .set(updates)
      .where(and(eq(paymentOrders.id, id), eq(paymentOrders.status, expectedStatus)))
      .returning();
    return rows[0] ?? null;
  }

  // ── Events ────────────────────────────────────────────────────────────────

  /**
   * Append an immutable payment event to the audit log.
   */
  async appendEvent(data: NewPaymentEventRow): Promise<PaymentEventRow> {
    const rows = await this.db.insert(paymentEvents).values(data).returning();
    const row = rows[0];
    if (!row) throw new Error('Event insert returned no rows');
    return row;
  }

  /**
   * List all events for an order, oldest first.
   */
  async listEventsByOrder(orderId: string): Promise<PaymentEventRow[]> {
    return this.db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.orderId, orderId))
      .orderBy(paymentEvents.createdAt);
  }
}
