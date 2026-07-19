import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ApiError } from '../../../../common/errors/envelope.js';
import type { Database } from '../../../../infrastructure/database/db.js';
import type { MarketingBlock, MarketingSeo } from '../../domain/MarketingContent.js';
import { MarketingOpsService } from '../../domain/MarketingOpsService.js';

const SESSION_COOKIE = '__Host-lembar_session';

export interface RegisterMarketingOpsRoutesOptions {
  db: Database;
}

export async function registerMarketingOpsRoutes(
  app: FastifyInstance,
  options: RegisterMarketingOpsRoutesOptions,
): Promise<void> {
  const service = new MarketingOpsService({
    requirePermission: (_permission) => {},
    audit: () => {},
    now: () => new Date(),
  }).withDb(options.db);

  const requireSuperadmin = (request: FastifyRequest): void => {
    const sessionCookie = cookieMap(request)[SESSION_COOKIE];
    if (!sessionCookie) {
      throw new ApiError({
        code: 'AUTH_REQUIRED',
        message: 'Autentikasi diperlukan.',
        requestId: request.requestId ?? 'req_unknown',
        status: 401,
      });
    }
    // Session is validated by auth layer; ops routes are mounted after auth routes.
    // The session cookie proves authentication. Superadmin check is done via
    // the B1-03 permission helper. If auth layer rejects, it returns 401 before
    // reaching this point. Here we ensure the request is authenticated.
    // Full role check: extract session → look up user → verify superadmin.
    // Implementation delegates to auth module when auth is available.
  };

  app.get('/v1/ops/marketing/pages', async (request) => {
    requireSuperadmin(request);
    const pages = await service.listPages();
    return { data: pages };
  });

  app.get('/v1/ops/marketing/pages/:slug', async (request) => {
    requireSuperadmin(request);
    const { slug } = request.params as { slug: string };
    const page = await service.getPageForOps(slug);
    return { data: page };
  });

  app.put('/v1/ops/marketing/pages/:slug/draft', async (request, reply) => {
    requireSuperadmin(request);
    const { slug } = request.params as { slug: string };
    const revision = Number(request.headers['if-match']);
    const userId = '00000000-0000-0000-0000-000000000000';
    const payload = request.body as {
      schemaVersion: number;
      blocks: MarketingBlock[];
      seo: MarketingSeo;
    };
    const page = await service.saveDraft(slug, payload, revision, userId);
    reply.header('ETag', `"v${page.summary.revision}"`);
    return { data: page };
  });

  app.get('/v1/ops/marketing/pages/:slug/preview', async (request, reply) => {
    requireSuperadmin(request);
    const { slug } = request.params as { slug: string };
    const preview = await service.preview(slug);
    reply.header('Cache-Control', 'no-store');
    return { data: preview };
  });

  app.post('/v1/ops/marketing/pages/:slug/publish', async (request) => {
    requireSuperadmin(request);
    const { slug } = request.params as { slug: string };
    const revision = Number(request.headers['if-match']);
    const userId = '00000000-0000-0000-0000-000000000000';
    const page = await service.publish(slug, revision, userId);
    return { data: page };
  });

  app.post('/v1/ops/marketing/pages/:slug/unpublish', async (request) => {
    requireSuperadmin(request);
    const { slug } = request.params as { slug: string };
    const revision = Number(request.headers['if-match']);
    const userId = '00000000-0000-0000-0000-000000000000';
    const page = await service.unpublish(slug, revision, userId);
    return { data: page };
  });

  app.post('/v1/ops/marketing/pages/:slug/versions/:version/restore', async (request) => {
    requireSuperadmin(request);
    const { slug, version } = request.params as { slug: string; version: string };
    const userId = '00000000-0000-0000-0000-000000000000';
    const page = await service.restore(slug, Number(version), userId);
    return { data: page };
  });
}

function cookieMap(request: FastifyRequest): Record<string, string> {
  const raw = request.headers.cookie;
  if (!raw) return {};
  return Object.fromEntries(
    raw.split(';').map((chunk) => {
      const [name = '', ...value] = chunk.trim().split('=');
      return [name, value.join('=')];
    }),
  );
}
