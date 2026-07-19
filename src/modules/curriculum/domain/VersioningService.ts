import { ApiError } from '../../../common/errors/envelope.js';
import {
  CurriculumRepository,
  etagForPayload,
  isApprovedSourceRights,
  type ResourceKey,
  type VersionRow,
} from './CurriculumRepository.js';

export const RESOURCE_KEYS = [
  'curricula',
  'grades',
  'phases',
  'subjects',
  'outcomes',
  'materials',
] as const satisfies readonly ResourceKey[];

export interface ResourceResponse {
  data: Record<string, unknown>;
  etag: string;
}

export interface VersionListResponse {
  data: VersionRow[];
  page: { limit: number; hasMore: boolean };
}

export class VersioningService {
  constructor(private readonly repo: CurriculumRepository) {}

  async createDraft(
    resource: ResourceKey,
    body: Record<string, unknown>,
    requestId: string,
  ): Promise<ResourceResponse> {
    requireObject(body, requestId);
    const row = await this.repo.createDraft(resource, body);
    return wrap(row.payload);
  }

  async updateDraft(
    resource: ResourceKey,
    id: string,
    body: Record<string, unknown>,
    requestId: string,
  ): Promise<ResourceResponse> {
    requireObject(body, requestId);
    const row = await this.repo.updateDraft(resource, id, body);
    if (!row) throw notFound(requestId);
    return wrap(row.payload);
  }

  async publish(
    resource: ResourceKey,
    id: string,
    requestId: string,
    actor: string | null = null,
  ): Promise<ResourceResponse> {
    const gate = await this.sourceRightsGate(resource, id, requestId);
    if (!gate.ok) {
      throw new ApiError({
        code: 'VALIDATION_FAILED',
        message: gate.reason ?? 'Publikasi tidak valid.',
        requestId,
        status: 400,
      });
    }
    try {
      const version = await this.repo.publish(resource, id, actor);
      if (!version) throw notFound(requestId);
      return wrap({
        ...version.payload,
        version: version.version,
        publishedAt: version.publishedAt,
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const message = err instanceof Error ? err.message : '';
      if (message === 'source_rights_not_approved') {
        throw new ApiError({
          code: 'VALIDATION_FAILED',
          message: 'Hak sumber materi belum disetujui.',
          requestId,
          status: 400,
        });
      }
      throw err;
    }
  }

  async listVersions(
    resource: ResourceKey,
    id: string,
    limit: number,
    requestId: string,
  ): Promise<VersionListResponse> {
    const head = await this.repo.getHead(resource, id);
    if (!head) throw notFound(requestId);
    const capped = Math.min(Math.max(limit, 1), 100);
    const rows = await this.repo.listVersions(resource, id, capped + 1);
    return { data: rows.slice(0, capped), page: { limit: capped, hasMore: rows.length > capped } };
  }

  async getVersion(
    resource: ResourceKey,
    id: string,
    version: number,
    requestId: string,
  ): Promise<ResourceResponse> {
    const row = await this.repo.getVersion(resource, id, version);
    if (!row) throw notFound(requestId);
    return wrap({ ...row.payload, version: row.version, publishedAt: row.publishedAt });
  }

  async readPublishedCatalog(tenantSlug: string, requestId: string): Promise<ResourceResponse> {
    const projection = await this.repo.readPublishedCatalogByTenantSlug(tenantSlug);
    if (!projection) throw notFound(requestId);
    return wrap(projection as unknown as Record<string, unknown>);
  }

  async sourceRightsGate(
    resource: ResourceKey,
    id: string,
    requestId: string,
  ): Promise<{ ok: boolean; reason: string | null }> {
    if (resource !== 'materials') return { ok: true, reason: null };
    const head = await this.repo.getHead(resource, id);
    if (!head) throw notFound(requestId);
    const rights = head.payload['source_rights'] ?? head.payload['sourceRights'];
    if (typeof rights === 'string' && isApprovedSourceRights(rights))
      return { ok: true, reason: null };
    return { ok: false, reason: 'Hak sumber materi belum disetujui.' };
  }
}

function wrap(data: Record<string, unknown>): ResourceResponse {
  return { data, etag: etagForPayload(data) };
}

function requireObject(body: Record<string, unknown>, requestId: string): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError({
      code: 'VALIDATION_FAILED',
      message: 'Payload tidak valid.',
      requestId,
      status: 400,
    });
  }
}

function notFound(requestId: string): ApiError {
  return new ApiError({
    code: 'RESOURCE_NOT_FOUND',
    message: 'Resource tidak ditemukan.',
    requestId,
    status: 404,
  });
}
