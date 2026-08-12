/**
 * WA Gateway admin routes — superadmin only (session-based auth).
 * Proxies to OpenWA container: http://172.21.0.3:2785/api/
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool, type Database } from '../../../../infrastructure/database/db.js';
import { ApiError } from '../../../../common/errors/envelope.js';

const OPENWA_BASE = (process.env['OPENWA_BASE_URL'] ?? 'http://172.21.0.3:2785').replace(/\/+$/, '');
const OPENWA_KEY = () => process.env['OPENWA_API_KEY'] ?? '';
const SESSION_COOKIE = '__Host-lembar_session';

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

async function requireSuperadmin(request: FastifyRequest, db: Database): Promise<void> {
  // Accept session ID from cookie OR Authorization: Bearer header (BFF proxy pattern)
  const raw = request.headers.cookie ?? '';
  const cookieSessionId = Object.fromEntries(
    raw.split(';').map(c => { const [k = '', ...v] = c.trim().split('='); return [k, v.join('=')]; })
  )[SESSION_COOKIE];
  const bearerSessionId = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim() || null;
  const sessionId = cookieSessionId || bearerSessionId;

  if (!sessionId) throw new ApiError({ code: 'AUTH_REQUIRED', message: 'Login diperlukan.', status: 401, requestId: '' });

  const pool = getPool(db);
  const res = await pool.query(
    `SELECT m.role FROM auth_sessions s
     JOIN auth_workspace_memberships m ON m.account_id = s.user_id
     WHERE s.id = $1 AND s.state = 'active'
     AND s.absolute_expires_at > now()
     AND m.role = 'superadmin' LIMIT 1`,
    [sessionId],
  );
  if (!res.rows.length) {
    throw new ApiError({ code: 'FORBIDDEN', message: 'Superadmin diperlukan.', status: 403, requestId: '' });
  }
}

export interface RegisterWaGatewayRoutesOptions { db: Database; jwtSecret: string; }

export async function registerWaGatewayRoutes(app: FastifyInstance, options: RegisterWaGatewayRoutesOptions): Promise<void> {
  const guard = (handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireSuperadmin(req, options.db);
        await handler(req, reply);
      } catch (e) {
        if (e instanceof ApiError) return reply.status(e.status).send(e.toEnvelope());
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
