/**
 * Payment domain errors (B6-02).
 */

export class DuplicateOrderError extends Error {
  readonly idempotencyKey: string;
  readonly existingOrderId: string;
  constructor(idempotencyKey: string, existingOrderId: string) {
    super(`Order with idempotency key "${idempotencyKey}" already exists (id: ${existingOrderId})`);
    this.name = 'DuplicateOrderError';
    this.idempotencyKey = idempotencyKey;
    this.existingOrderId = existingOrderId;
  }
}

export class OrderNotFoundError extends Error {
  constructor(orderId: string) {
    super(`Payment order not found: ${orderId}`);
    this.name = 'OrderNotFoundError';
  }
}

export class InvalidOrderTransitionError extends Error {
  readonly fromStatus: string;
  readonly toStatus: string;
  constructor(orderId: string, from: string, to: string) {
    super(`Cannot transition order ${orderId} from "${from}" to "${to}"`);
    this.name = 'InvalidOrderTransitionError';
    this.fromStatus = from;
    this.toStatus = to;
  }
}

export class WebhookSignatureError extends Error {
  constructor(gateway: string) {
    super(`Invalid webhook signature from gateway: ${gateway}`);
    this.name = 'WebhookSignatureError';
  }
}

export class InvalidPlanTransitionError extends Error {
  constructor(from: string, to: string, reason: string) {
    super(`Cannot transition plan from "${from}" to "${to}": ${reason}`);
    this.name = 'InvalidPlanTransitionError';
  }
}
