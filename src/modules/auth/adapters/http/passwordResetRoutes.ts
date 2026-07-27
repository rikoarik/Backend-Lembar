import type { FastifyInstance } from 'fastify';

import { throwApiError } from '../../../../common/errors/apiError.js';
import type { Database } from '../../../../infrastructure/database/db.js';
import { PasswordResetService } from '../../application/PasswordResetService.js';

export interface RegisterPasswordResetRoutesOptions {
  db: Database;
}

export async function registerPasswordResetRoutes(
  app: FastifyInstance,
  options: RegisterPasswordResetRoutesOptions,
): Promise<void> {
  const service = new PasswordResetService(options.db);

  app.post('/v1/auth/reset-password', async (request, reply) => {
    const body = request.body as { token?: string; newPassword?: string } | null;
    if (!body?.token || !body?.newPassword) {
      throwApiError('missing_fields', 'token dan newPassword diperlukan');
    }

    await service.apply(body.token, body.newPassword);
    return reply.status(200).send({ data: { reset: true } });
  });
}
