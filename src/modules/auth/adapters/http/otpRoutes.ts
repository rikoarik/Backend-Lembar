/**
 * WA OTP routes — public (no JWT).
 * POST /v1/auth/otp/request  { phone }
 * POST /v1/auth/otp/verify   { phone, code }
 */
import type { FastifyInstance } from 'fastify';
import { throwApiError } from '../../../../common/errors/apiError.js';
import { rateLimit } from '../../../../common/security/rateLimit.js';
import type { Database } from '../../../../infrastructure/database/db.js';
import { OtpService } from '../../application/OtpService.js';

export interface RegisterOtpRoutesOptions {
  db: Database;
}

export async function registerOtpRoutes(
  app: FastifyInstance,
  options: RegisterOtpRoutesOptions,
): Promise<void> {
  const service = new OtpService(options.db);

  // POST /v1/auth/otp/request
  app.post('/v1/auth/otp/request', async (request, reply) => {
    const body = request.body as { phone?: unknown };
    const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
    if (!phone) throwApiError('missing_fields', 'Nomor telepon diperlukan.', 400);

    // IP-level rate limit: 10 requests per 10 minutes
    rateLimit(request, reply, 'otp-request', 10, 10 * 60 * 1000);

    const result = await service.request(phone);
    return reply.status(200).send({ data: { expiresAt: result.expiresAt } });
  });

  // POST /v1/auth/otp/verify
  app.post('/v1/auth/otp/verify', async (request, reply) => {
    const body = request.body as { phone?: unknown; code?: unknown };
    const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!phone || !code) throwApiError('missing_fields', 'Nomor telepon dan kode OTP diperlukan.', 400);

    // Brute-force guard: 10 attempts per IP per 15 minutes
    rateLimit(request, reply, 'otp-verify', 10, 15 * 60 * 1000);

    const result = await service.verify(phone, code);
    return reply.status(200).send({ data: result });
  });
}
