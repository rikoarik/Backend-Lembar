/**
 * Payment module exports (B6-02).
 */
export { PaymentService } from './application/PaymentService.js';
export type { PaymentServiceOptions } from './application/PaymentService.js';
export { PaymentRepository } from './persistence/repository.js';
export { paymentOrders, paymentEvents } from './persistence/schema.js';
export type { PaymentOrderRow, NewPaymentOrderRow, PaymentEventRow, NewPaymentEventRow } from './persistence/schema.js';
export type {
  PaymentOrder,
  PaymentOrderStatus,
  PaymentPlanType,
  PaymentEvent,
  PaymentEventType,
  CreateOrderInput,
  CreateOrderResult,
  WebhookPayload,
  WebhookHandleResult,
  PlanChangeInput,
  PlanChangeResult,
} from './domain/types.js';
export {
  DuplicateOrderError,
  OrderNotFoundError,
  InvalidOrderTransitionError,
  WebhookSignatureError,
  InvalidPlanTransitionError,
} from './domain/errors.js';
export { registerWebhookRoutes } from './adapters/http/webhookRoutes.js';
export { registerSubscriptionRoutes } from './adapters/http/subscriptionRoutes.js';
