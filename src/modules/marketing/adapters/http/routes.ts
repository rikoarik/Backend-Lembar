import type { FastifyInstance } from 'fastify';

import { getPool, type Database } from '../../../../infrastructure/database/db.js';
import { MarketingRepository } from '../../domain/MarketingRepository.js';

export interface RegisterMarketingRoutesOptions {
  db: Database;
}

const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';
// FE-friendly alias for the marketing site (TTL 30s); keeps the canonical /v1/public route untouched.
const CACHE_CONTROL_SHORT = 'public, max-age=30, stale-while-revalidate=120';

export async function registerMarketingRoutes(
  app: FastifyInstance,
  options: RegisterMarketingRoutesOptions,
): Promise<void> {
  const repo = new MarketingRepository(options.db);

  app.get('/v1/public/announcement', async (_request, reply) => {
    const pool = getPool(options.db);
    if (!pool) return reply.status(503).send({ error: { code: 'DATABASE_UNAVAILABLE' } });
    const result = await pool.query<{
      enabled: boolean;
      label: string;
      message: string;
      cta_label: string | null;
      cta_href: string | null;
      revision: number;
      updated_at: Date;
    }>(
      `SELECT enabled, label, message, cta_label, cta_href, revision, updated_at
         FROM platform_announcement
        WHERE id = 'global'
        LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND' } });
    return reply
      .header('Cache-Control', CACHE_CONTROL_SHORT)
      .status(200)
      .send({
        data: {
          enabled: row.enabled,
          label: row.label,
          message: row.message,
          ctaLabel: row.cta_label,
          ctaHref: row.cta_href,
          revision: row.revision,
          updatedAt: row.updated_at.toISOString(),
        },
      });
  });

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

  // FE-friendly alias: /v1/marketing/pages/:slug (TTL 30s) for the marketing site.
  // ponytail: collapses to a single route + cache header once the legacy /v1/public alias is retired.
  app.get('/v1/marketing/pages/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const result = await repo.readPage(
      slug,
      request.requestId ?? 'req_unknown',
      localeOf(request.query),
    );
    if (request.headers['if-none-match'] === result.etag) return reply.status(304).send();
    return reply
      .header('ETag', result.etag)
      .header('Cache-Control', CACHE_CONTROL_SHORT)
      .status(200)
      .send({ data: result.data });
  });
}

function localeOf(query: unknown): string {
  if (!query || typeof query !== 'object') return 'id-ID';
  const value = (query as Record<string, unknown>)['locale'];
  return typeof value === 'string' ? value : 'id-ID';
}
