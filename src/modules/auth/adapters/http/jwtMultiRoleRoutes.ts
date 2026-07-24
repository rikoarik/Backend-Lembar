import type { FastifyInstance, FastifyRequest } from 'fastify';
import { throwApiError } from '../../../../common/errors/apiError.js';
import type { Database } from '../../../../infrastructure/database/db.js';
import { JwtMultiRoleAuthService } from '../../application/JwtMultiRoleAuthService.js';
import { createJwtAuthMiddleware, requireRole } from '../../../../common/middleware/jwtMultiRoleAuth.js';

export interface RegisterJwtMultiRoleRoutesOptions {
  db: Database;
  jwtSecret: string;
  jwtExpiryDays: number;
}

export async function registerJwtMultiRoleRoutes(
  app: FastifyInstance,
  options: RegisterJwtMultiRoleRoutesOptions,
): Promise<void> {
  const service = new JwtMultiRoleAuthService(options.db, {
    secret: options.jwtSecret,
    expiryDays: options.jwtExpiryDays,
  });

  const authMiddleware = createJwtAuthMiddleware({ secret: options.jwtSecret });

  // POST /v1/auth/register
  app.post('/v1/auth/register', async (request, reply) => {
    const body = request.body as {
      email: string;
      password: string;
      name?: string;
      username?: string;
      phone?: string;
      roles?: string[] | undefined;
    };

    const name = (body.name ?? body.username ?? '').trim();
    if (!body.email || !body.password || !name) {
      throwApiError('missing_fields', 'Email, password, dan username/name diperlukan');
    }

    const result = await service.register({
      email: body.email,
      password: body.password,
      name,
      username: body.username ?? name,
      ...(body.phone ? { phone: body.phone } : {}),
      ...(body.roles ? { roles: body.roles as any } : {}),
    });
    return reply.status(201).send(result);
  });

  // POST /v1/auth/login
  app.post('/v1/auth/login', async (request, reply) => {
    const body = request.body as {
      email?: string;
      identifier?: string;
      password: string;
    };

    if ((!body.email && !body.identifier) || !body.password) {
      throwApiError('missing_fields', 'Email/username/telepon dan password diperlukan');
    }

    const result = await service.login(body);
    return reply.status(200).send(result);
  });

  // GET /v1/auth/me
  app.get(
    '/v1/auth/me',
    {
      preHandler: authMiddleware,
    },
    async (request, reply) => {
      const token = extractBearerToken(request);
      if (!token) {
        throwApiError('missing_token', 'Authorization header diperlukan');
      }

      const user = await service.getCurrentUser(token);
      return reply.status(200).send(user);
    },
  );

  // PATCH /v1/auth/me/roles (superadmin only)
  app.patch(
    '/v1/auth/me/roles',
    {
      preHandler: [authMiddleware, requireRole(['superadmin'])],
    },
    async (request, reply) => {
      const body = request.body as { roles: string[] };

      if (!body.roles || !Array.isArray(body.roles)) {
        throwApiError('invalid_input', 'Roles harus berupa array');
      }

      const userId = request.jwtUser!.userId;
      const user = await service.updateRoles(userId, { roles: body.roles as any });
      return reply.status(200).send(user);
    },
  );

  // GET /v1/me (backward compat — matches OpenAPI spec)
  app.get(
    '/v1/me',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const token = extractBearerToken(request);
      if (!token) throwApiError('missing_token', 'Authorization header diperlukan');
      const user = await service.getCurrentUser(token);
      return reply.status(200).send({ data: user });
    },
  );

  // GET /v1/dashboard/summary (backward compat — matches OpenAPI spec)
  app.get(
    '/v1/dashboard/summary',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const token = extractBearerToken(request);
      if (!token) throwApiError('missing_token', 'Authorization header diperlukan');
      const user = await service.getCurrentUser(token);
      return reply.status(200).send({
        data: {
          activeWorkspaceId: user.workspaceId,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            roles: user.roles,
          },
        },
      });
    },
  );
}

function extractBearerToken(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (!auth) return null;

  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;

  return parts[1] || null;
}
