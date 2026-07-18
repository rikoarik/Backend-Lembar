import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';

const SAFE_ID = /^[A-Za-z0-9_-]{8,128}$/;

function newRequestId(): string {
  return `req_${randomBytes(12).toString('base64url')}`;
}

// Accept only opaque ids matching SAFE_ID; reject whitespace, semicolons, control chars,
// and anything that could pollute log lines or response headers.
function isSafeRequestId(value: string): boolean {
  return SAFE_ID.test(value);
}

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

export function registerRequestId(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const incomingStr = Array.isArray(incoming) ? incoming[0] : incoming;
    const id = incomingStr && isSafeRequestId(incomingStr) ? incomingStr : newRequestId();
    req.requestId = id;
    void reply.header(REQUEST_ID_HEADER, id);
  });
}
