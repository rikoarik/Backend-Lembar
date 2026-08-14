/**
 * WA Gateway admin routes — superadmin only (JWT auth).
 * Proxies to OpenWA container: http://172.21.0.3:2785/api/
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createJwtAuthMiddleware, requireRole } from '../../../../common/middleware/jwtMultiRoleAuth.js';
import type { Database } from '../../../../infrastructure/database/db.js';

const OPENWA_BASE = (process.env['OPENWA_BASE_URL'] ?? 'http://172.21.0.3:2785').replace(/\/+$/, '');
const OPENWA_KEY = () => process.env['OPENWA_API_KEY'] ?? '';

async function openwa(method: string, path: string, body?: unknown) {
  const res = await fetch(`${OPENWA_BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': OPENWA_KEY(), Host: 'localhost' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  return { status: res.status, json };
}

export interface RegisterWaGatewayRoutesOptions { db: Database; jwtSecret: string; }

export async function registerWaGatewayRoutes(app: FastifyInstance, options: RegisterWaGatewayRoutesOptions): Promise<void> {
  const auth = createJwtAuthMiddleware({ secret: options.jwtSecret, db: options.db });
  const superadmin = requireRole(['superadmin']);
  const guard = (handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        await auth(req, reply);
        superadmin(req, reply);
        await handler(req, reply);
      } catch (e) {
        throw e;
      }
    };

  app.get('/v1/admin/wa-gateway', guard(async (_req, reply) => {
    const { status, json } = await openwa('GET', '/sessions');
    return reply.status(status).send(json);
  }));
  app.post('/v1/admin/wa-gateway', guard(async (req, reply) => {
    const { status, json } = await openwa('POST', '/sessions', req.body);
    return reply.status(status).send(json);
  }));
  app.post('/v1/admin/wa-gateway/:id/start', guard(async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status, json } = await openwa('POST', `/sessions/${id}/start`);
    return reply.status(status).send(json);
  }));
  app.get('/v1/admin/wa-gateway/:id/qr', guard(async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status, json } = await openwa('GET', `/sessions/${id}/qr`);
    return reply.status(status).send(json);
  }));
  app.delete('/v1/admin/wa-gateway/:id', guard(async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status, json } = await openwa('DELETE', `/sessions/${id}`);
    return reply.status(status).send(json);
  }));
}
