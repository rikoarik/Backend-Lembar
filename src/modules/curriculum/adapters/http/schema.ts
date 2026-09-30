import type { FastifyRequest } from 'fastify';

import { bearerTokenFrom, stubBearerAllowed } from '../../../../common/auth/stubBearer.js';
import { ApiError } from '../../../../common/errors/envelope.js';
import { parseCurriculumEnv } from '../../../../config/curriculum.env.js';
import type { ResourceKey } from '../../domain/CurriculumRepository.js';
import { RESOURCE_KEYS } from '../../domain/VersioningService.js';

export function resourceOf(value: string, request: FastifyRequest): ResourceKey {
  if ((RESOURCE_KEYS as readonly string[]).includes(value)) return value as ResourceKey;
  throw new ApiError({
    code: 'RESOURCE_NOT_FOUND',
    message: 'Resource tidak ditemukan.',
    requestId: request.requestId ?? 'req_unknown',
    status: 404,
  });
}

export function objectBody(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

export function limitOf(request: FastifyRequest): number {
  const raw = (request.query as { limit?: string | number } | undefined)?.limit;
  const value = Number(raw ?? 20);
  return Number.isInteger(value) ? Math.min(Math.max(value, 1), 100) : 20;
}

/**
 * Verify the curriculum write bearer (AUDIT-2 / t_02e3d131).
 *
 * Fails closed: when `CURRICULUM_WRITE_TOKEN` is unset/empty every request is
 * rejected with 401, so a missing configuration can never again mean "accept
 * any non-empty Bearer token". A wrong-but-non-empty token is rejected too; only
 * the exact configured value passes. `assertCurriculumWriteTokenConfigured`
 * makes the same condition a boot-time failure in production.
 */
export function bearerActor(request: FastifyRequest): string {
  const token = bearerTokenFrom(request.headers.authorization);
  const expected = parseCurriculumEnv(process.env).bearerToken;
  if (!stubBearerAllowed(expected, token)) {
    throw new ApiError({
      code: 'AUTH_REQUIRED',
      message: 'Autentikasi diperlukan.',
      requestId: request.requestId ?? 'req_unknown',
      status: 401,
    });
  }
  return 'catalog-stub-actor';
}
