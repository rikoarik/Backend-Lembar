/**
 * WA Gateway admin routes — superadmin only (JWT auth).
 * Proxies to OpenWA container: http://172.21.0.3:2785/api/
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createJwtAuthMiddleware, requireRole } from '../../../../common/middleware/jwtMultiRoleAuth.js';
import type { Database } from '../../../../infrastructure/database/db.js';
import { request as httpRequest } from 'node:http';

const OPENWA_DEFAULT_BASE = 'http://172.21.0.3:2785';

function openwaBase(): string {
  return (process.env['OPENWA_BASE_URL'] ?? OPENWA_DEFAULT_BASE).replace(/\/+$/, '');
}

function openwaKey(): string {
  return (process.env['OPENWA_API_KEY'] ?? '').trim();
}

function openwaHttp(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const key = openwaKey();
  if (!key) {
    return Promise.resolve({ status: 500, json: { error: { code: 'OPENWA_KEY_MISSING', message: 'OPENWA_API_KEY belum diset.' } } });
  }

  const url = new URL(`${openwaBase()}/api${path}`);
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Host: 'localhost',
          'X-API-Key': key,
          ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let json: unknown = {};
          if (data) {
            try {
              json = JSON.parse(data);
            } catch {
              json = { message: data };
            }
          }
          resolve({ status: res.statusCode ?? 502, json });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
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
    const { status, json } = await openwaHttp('GET', '/sessions');
    return reply.status(status).send(json);
  }));
  app.post('/v1/admin/wa-gateway', guard(async (req, reply) => {
    const { status, json } = await openwaHttp('POST', '/sessions', req.body);
    return reply.status(status).send(json);
  }));
  app.post('/v1/admin/wa-gateway/:id/start', guard(async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status, json } = await openwaHttp('POST', `/sessions/${id}/start`);
    return reply.status(status).send(json);
  }));
  app.get('/v1/admin/wa-gateway/:id/qr', guard(async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status, json } = await openwaHttp('GET', `/sessions/${id}/qr`);
    return reply.status(status).send(json);
  }));
  app.delete('/v1/admin/wa-gateway/:id', guard(async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status, json } = await openwaHttp('DELETE', `/sessions/${id}`);
    return reply.status(status).send(json);
  }));
}
