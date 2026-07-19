import type { FastifyInstance } from 'fastify';

import { type Database } from '../../../../infrastructure/database/db.js';
import { CurriculumRepository, type ResourceKey } from '../../domain/CurriculumRepository.js';
import { VersioningService } from '../../domain/VersioningService.js';
import { bearerActor, limitOf, objectBody, resourceOf } from './schema.js';

export interface RegisterCurriculumRoutesOptions {
  db: Database;
}

export async function registerCurriculumRoutes(
  app: FastifyInstance,
  options: RegisterCurriculumRoutesOptions,
): Promise<void> {
  const service = new VersioningService(new CurriculumRepository(options.db));

  app.get('/v1/curriculum/curricula/:tenantSlug', async (request, reply) => {
    const { tenantSlug } = request.params as { tenantSlug: string };
    const result = await service.readPublishedCatalog(
      tenantSlug,
      request.requestId ?? 'req_unknown',
    );
    if (request.headers['if-none-match'] === result.etag) return reply.status(304).send();
    return reply.header('ETag', result.etag).status(200).send({ data: result.data });
  });

  for (const resource of [
    'curricula',
    'grades',
    'phases',
    'subjects',
    'outcomes',
    'materials',
  ] as const) {
    registerResourceRoutes(app, service, resource);
  }

  app.post('/v1/curriculum/:resource/:id/source-rights-gate', async (request) => {
    bearerActor(request);
    const { resource: raw, id } = request.params as { resource: string; id: string };
    const resource = resourceOf(raw, request);
    const result = await service.sourceRightsGate(resource, id, request.requestId ?? 'req_unknown');
    return { data: result };
  });
}

function registerResourceRoutes(
  app: FastifyInstance,
  service: VersioningService,
  resource: ResourceKey,
): void {
  app.post(`/v1/curriculum/${resource}`, async (request, reply) => {
    const actor = bearerActor(request);
    void actor;
    const result = await service.createDraft(
      resource,
      objectBody(request),
      request.requestId ?? 'req_unknown',
    );
    return reply.header('ETag', result.etag).status(201).send({ data: result.data });
  });

  app.put(`/v1/curriculum/${resource}/:id/draft`, async (request, reply) => {
    bearerActor(request);
    const { id } = request.params as { id: string };
    const result = await service.updateDraft(
      resource,
      id,
      objectBody(request),
      request.requestId ?? 'req_unknown',
    );
    return reply.header('ETag', result.etag).status(200).send({ data: result.data });
  });

  app.post(`/v1/curriculum/${resource}/:id/publish`, async (request, reply) => {
    const actor = bearerActor(request);
    const { id } = request.params as { id: string };
    const result = await service.publish(resource, id, request.requestId ?? 'req_unknown', actor);
    return reply.header('ETag', result.etag).status(200).send({ data: result.data });
  });

  app.get(`/v1/curriculum/${resource}/:id/versions`, async (request) => {
    const { id } = request.params as { id: string };
    return service.listVersions(resource, id, limitOf(request), request.requestId ?? 'req_unknown');
  });

  app.get(`/v1/curriculum/${resource}/:id/versions/:version`, async (request, reply) => {
    const { id, version } = request.params as { id: string; version: string };
    const result = await service.getVersion(
      resource,
      id,
      Number(version),
      request.requestId ?? 'req_unknown',
    );
    if (request.headers['if-none-match'] === result.etag) return reply.status(304).send();
    return reply.header('ETag', result.etag).status(200).send({ data: result.data });
  });
}
