export class QueueError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'QueueError';
  }
}

export class IdempotencyKeyReusedError extends QueueError {
  constructor() {
    super(
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency key reused with another request fingerprint.',
      409,
    );
  }
}
