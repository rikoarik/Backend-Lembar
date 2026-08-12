/**
 * WA Gateway admin routes — superadmin only.
 * Proxies to OpenWA container: http://172.21.0.3:2785/api/sessions
 *
 * GET  /v1/admin/wa-gateway        → list sessions
 * POST /v1/admin/wa-gateway        → create session
 * POST /v1/admin/wa-gateway/:id/start → start session
 * GET  /v1/admin/wa-gateway/:id/qr → get QR code
 * DELETE /v1/admin/wa-gateway/:id  → delete session
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../../../infrastructure/database/db.js';
import {
  createJwtAuthMiddleware,
  requireRole,
} from '../../../../common/middleware/jwtMultiRoleAuth.js';

const OPENWA_BASE = (process.env['OPENWA_BASE_URL'] ?? 'http://172.21.0.3:2785').replace(/\/+$/, '');
const OPENWA_KEY = () => process.env['OPENWA_API_KEY'] ?? '';

async function openwa(method: string, path: string, body?: unknown) {
  const res = await fetch(`${OPENWA_BASE}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': OPENWA_KEY(),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  return { status: res.status, json };
}

export interface RegisterWaGatewayRoutesOptions {
  db: Database;
  jwtSecret: string;
}

export async function registerWaGatewayRoutes(
  app: FastifyInstance,
  options: RegisterWaGatewayRoutesOptions,
): Promise<void> {
  const auth = createJwtAuthMiddleware({ secret: options.jwtSecret, db: options.db });
  const superadmin = requireRole(['superadmin']);

  app.get('/v1/admin/wa-gateway', { preHandler: [auth, superadmin] }, async (_req, reply) => {
    const { status, json } = await openwa('GET', '/sessions');
    return reply.status(status).send(json);
  });

  app.post('/v1/admin/wa-gateway', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { status, json } = await openwa('POST', '/sessions', request.body);
    return reply.status(status).send(json);
  });

  app.post('/v1/admin/wa-gateway/:id/start', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status, json } = await openwa('POST', `/sessions/${id}/start`);
    return reply.status(status).send(json);
  });

  app.get('/v1/admin/wa-gateway/:id/qr', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status, json } = await openwa('GET', `/sessions/${id}/qr`);
    return reply.status(status).send(json);
  });

  app.delete('/v1/admin/wa-gateway/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status, json } = await openwa('DELETE', `/sessions/${id}`);
    return reply.status(status).send(json);
  });
}
