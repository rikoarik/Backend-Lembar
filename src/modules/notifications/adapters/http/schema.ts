import { ApiError } from '../../../../common/errors/envelope.js';
import type { FastifyRequest } from 'fastify';

export interface DispatchBody {
  templateKey: string;
  recipient: { kind: 'email' | 'sms'; value: string };
  payload: Record<string, unknown>;
  eventId: string;
  locale?: string;
  visibleAt?: string;
}

export interface DispatchResponseBody {
  data: {
    status: 'dispatched' | 'duplicate' | 'rejected';
    outboxId: string | null;
    locale: string;
    redactedRecipient: string;
    subjectHash: string;
  };
}

export function parseDispatchBody(request: FastifyRequest): DispatchBody {
  const body = (request.body ?? {}) as Partial<DispatchBody>;
  const errors: Record<string, string[]> = {};

  if (typeof body.templateKey !== 'string' || body.templateKey.length === 0) {
    errors['templateKey'] = ['required'];
  }
  if (
    !body.recipient ||
    typeof body.recipient !== 'object' ||
    typeof body.recipient.value !== 'string' ||
    body.recipient.value.length === 0 ||
    (body.recipient.kind !== 'email' && body.recipient.kind !== 'sms')
  ) {
    errors['recipient'] = ['required: { kind: email|sms, value: string }'];
  }
  if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
    errors['payload'] = ['required: object'];
  }
  if (typeof body.eventId !== 'string' || body.eventId.length === 0) {
    errors['eventId'] = ['required'];
  }
  if (body.locale !== undefined && typeof body.locale !== 'string') {
    errors['locale'] = ['must be string'];
  }
  if (body.visibleAt !== undefined && typeof body.visibleAt !== 'string') {
    errors['visibleAt'] = ['must be ISO timestamp string'];
  }

  if (Object.keys(errors).length > 0) {
    throw new ApiError({
      code: 'VALIDATION_FAILED',
      message: 'Permintaan tidak valid.',
      requestId: request.requestId ?? 'req_unknown',
      status: 400,
      fieldErrors: errors,
    });
  }

  return body as DispatchBody;
}
