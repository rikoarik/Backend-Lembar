import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ApiError } from '../../../../common/errors/envelope.js';
import type { Database } from '../../../../infrastructure/database/db.js';
import {
  createJwtAuthMiddleware,
  requireRole,
} from '../../../../common/middleware/jwtMultiRoleAuth.js';
import type { MarketingBlock, MarketingSeo } from '../../domain/MarketingContent.js';
import { MarketingOpsService } from '../../domain/MarketingOpsService.js';

export interface RegisterMarketingOpsRoutesOptions {
  db: Database;
  jwtSecret?: string;
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

  const jwtSecret = options.jwtSecret ?? process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  const authMiddleware = createJwtAuthMiddleware({ secret: jwtSecret });
  const superadminOnly = requireRole(['superadmin']);

  const requireSuperadmin = async (request: FastifyRequest): Promise<void> => {
    // Prefer JWT superadmin; keep legacy session cookie as fallback.
    const auth = request.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      await authMiddleware(request, {} as never);
      await superadminOnly(request, {} as never);
      return;
    }

    const sessionCookie = cookieMap(request)['__Host-lembar_session'];
    if (!sessionCookie) {
      throw new ApiError({
        code: 'AUTH_REQUIRED',
        message: 'Autentikasi diperlukan. Gunakan Authorization: Bearer <jwt> dengan role superadmin.',
        requestId: request.requestId ?? 'req_unknown',
        status: 401,
      });
    }
  };

  app.get('/v1/ops/marketing/pages', async (request) => {
    await requireSuperadmin(request);
    const pages = await service.listPages();
    return { data: pages };
  });

  app.get('/v1/ops/marketing/pages/:slug', async (request) => {
    await requireSuperadmin(request);
    const { slug } = request.params as { slug: string };
    const page = await service.getPageForOps(slug);
    return { data: page };
  });

  app.put('/v1/ops/marketing/pages/:slug/draft', async (request, reply) => {
    await requireSuperadmin(request);
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
    await requireSuperadmin(request);
    const { slug } = request.params as { slug: string };
    const revision = Number(request.headers['if-match']);
    const userId = '00000000-0000-0000-0000-000000000000';
    const page = await service.publish(slug, revision, userId);
    return { data: page };
  });

  app.post('/v1/ops/marketing/pages/:slug/unpublish', async (request) => {
    await requireSuperadmin(request);
    const { slug } = request.params as { slug: string };
    const revision = Number(request.headers['if-match']);
    const userId = '00000000-0000-0000-0000-000000000000';
    const page = await service.unpublish(slug, revision, userId);
    return { data: page };
  });

  app.post('/v1/ops/marketing/pages/:slug/versions/:version/restore', async (request) => {
    await requireSuperadmin(request);
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
