import type { FastifyError, FastifyInstance } from 'fastify';

import { ApiError, buildErrorEnvelope, type StableErrorCode } from '../common/errors/envelope.js';
import { mapFastifyError } from '../common/errors/fastifyErrors.js';
import { REQUEST_ID_HEADER } from '../common/middleware/request-id.js';

/**
 * Hints for known-but-unregistered route prefixes, surfaced in the 404 body.
 */
const NOT_FOUND_HINTS: Readonly<Record<string, string>> = {
  '/v1/admin': 'Module admin belum di-register. Butuh AdminDataStore implementation.',
  '/v1/catalog':
    'Module catalog belum di-register. Endpoint ada di OpenAPI spec tapi belum ada backend implementation.',
};

/**
 * Build the error envelope for a status/code pair.
 *
 * `retryable` is derived from the HTTP status: only 5xx failures are worth
 * retrying. A 4xx envelope must never advertise `retryable: true`, otherwise
 * clients retry invalid input forever.
 */
export function envelopeFor(
  status: number,
  code: StableErrorCode,
  message: string,
  requestId: string,
): { status: number; payload: ReturnType<typeof buildErrorEnvelope> } {
  const retryable = status >= 500;
  return {
    status,
    payload: buildErrorEnvelope({
      code,
      message,
      requestId,
      retryable,
    }),
  };
}

/**
 * Register the shared 404 + error handlers on an app instance.
 *
 * Exported separately from `buildApp` so route-level tests can assert the real
 * HTTP status/code/retryable triple an endpoint produces without booting the
 * whole application (see `test/modules/auth/register-password-policy.test.ts`).
 */
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((req, reply) => {
    const id = req.requestId ?? 'req_unknown';
    const url = req.url;
    const method = req.method;

    const hintKey = Object.keys(NOT_FOUND_HINTS).find((k) => url.startsWith(k));
    const message = hintKey
      ? `${NOT_FOUND_HINTS[hintKey]} (${method} ${url})`
      : `Endpoint tidak ditemukan: ${method} ${url}. Cek /docs untuk daftar endpoint yang tersedia.`;

    const { status, payload } = envelopeFor(404, 'RESOURCE_NOT_FOUND', message, id);
    void reply.header(REQUEST_ID_HEADER, id);
    void reply.status(status).send(payload);
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const id = req.requestId ?? 'req_unknown';
    void reply.header(REQUEST_ID_HEADER, id);
    if (err instanceof ApiError) {
      const { status, payload } = envelopeFor(err.status, err.code, err.message, id);
      void reply.status(status).send(payload);
      return;
    }
    // BUG-18: Fastify's content-type-parser errors (body over `bodyLimit`,
    // unsupported media type, bad Content-Length, malformed JSON) carry the
    // correct 4xx on `statusCode`. Mapping them here keeps them out of the 500
    // branch so clients get a stable envelope instead of "unhandled error".
    const mapped = mapFastifyError(err);
    if (mapped) {
      const { status, payload } = envelopeFor(mapped.status, mapped.code, mapped.message, id);
      void reply.status(status).send(payload);
      return;
    }
    app.log.error({ err: { name: err.name, message: err.message } }, 'unhandled error');
    const { status, payload } = envelopeFor(
      500,
      'INTERNAL_ERROR',
      'Terjadi kesalahan pada server.',
      id,
    );
    void reply.status(status).send(payload);
  });
}
