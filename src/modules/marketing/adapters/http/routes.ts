import type { FastifyInstance } from 'fastify';

import { type Database } from '../../../../infrastructure/database/db.js';
import { MarketingRepository } from '../../domain/MarketingRepository.js';

export interface RegisterMarketingRoutesOptions {
  db: Database;
}

const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';

export async function registerMarketingRoutes(
  app: FastifyInstance,
  options: RegisterMarketingRoutesOptions,
): Promise<void> {
  const repo = new MarketingRepository(options.db);

  app.get('/v1/public/marketing/global', async (request, reply) => {
    const result = await repo.readGlobal(
      request.requestId ?? 'req_unknown',
      localeOf(request.query),
    );
    if (request.headers['if-none-match'] === result.etag) return reply.status(304).send();
    return reply
      .header('ETag', result.etag)
      .header('Cache-Control', CACHE_CONTROL)
      .status(200)
      .send({ data: result.data });
  });

  app.get('/v1/public/marketing/pages/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const result = await repo.readPage(
      slug,
      request.requestId ?? 'req_unknown',
      localeOf(request.query),
    );
    if (request.headers['if-none-match'] === result.etag) return reply.status(304).send();
    return reply
      .header('ETag', result.etag)
      .header('Cache-Control', CACHE_CONTROL)
      .status(200)
      .send({ data: result.data });
  });
}

function localeOf(query: unknown): string {
  if (!query || typeof query !== 'object') return 'id-ID';
  const value = (query as Record<string, unknown>)['locale'];
  return typeof value === 'string' ? value : 'id-ID';
}
