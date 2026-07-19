import { createHash } from 'node:crypto';

import { ApiError } from '../../../common/errors/envelope.js';
import { getPool, type Database } from '../../../infrastructure/database/db.js';
import {
  MARKETING_GLOBAL_SLUG,
  MARKETING_LOCALE,
  MARKETING_PAGE_SLUGS,
  type MarketingGlobalDocument,
  type MarketingPageDocument,
  type MarketingPageSlug,
  type PublishedMarketing,
} from './MarketingContent.js';

export class MarketingRepository {
  constructor(private readonly db: Database) {}

  async readGlobal(
    requestId: string,
    locale = MARKETING_LOCALE,
  ): Promise<PublishedMarketing<MarketingGlobalDocument>> {
    requireLocale(locale, requestId);
    const row = await this.publishedRow('global', MARKETING_GLOBAL_SLUG, locale);
    if (!row) throw notFound(requestId);
    const data = requireGlobalPayload(row.payload, Number(row.version), requestId);
    return { data, etag: etagForPayload(data) };
  }

  async readPage(
    slug: string,
    requestId: string,
    locale = MARKETING_LOCALE,
  ): Promise<PublishedMarketing<MarketingPageDocument>> {
    requireLocale(locale, requestId);
    if (!isMarketingPageSlug(slug)) throw notFound(requestId);
    const row = await this.publishedRow('page', slug, locale);
    if (!row) throw notFound(requestId);
    const data = requirePagePayload(row.payload, slug, Number(row.version), requestId);
    return { data, etag: etagForPayload(data) };
  }

  private async publishedRow(
    kind: 'global' | 'page',
    slug: string,
    locale: string,
  ): Promise<{ version: number; payload: unknown } | null> {
    const pool = getPool(this.db);
    if (!pool) throw new Error('database handle has no managed pool');
    const result = await pool.query(
      `select v.version, v.payload
       from marketing_content c
       join marketing_content_versions v on v.content_id = c.id and v.version = c.published_version
       where c.kind = $1 and c.slug = $2 and c.locale = $3
       limit 1`,
      [kind, slug, locale],
    );
    return (result.rows[0] as { version: number; payload: unknown } | undefined) ?? null;
  }
}

export function etagForPayload(payload: unknown): string {
  return `"sha256:${createHash('sha256').update(stableJson(payload)).digest('hex')}"`;
}

function requireLocale(locale: string, requestId: string): void {
  if (locale !== MARKETING_LOCALE) {
    throw new ApiError({
      code: 'VALIDATION_FAILED',
      message: 'Locale marketing tidak didukung.',
      requestId,
      status: 400,
    });
  }
}

function requireGlobalPayload(
  payload: unknown,
  version: number,
  requestId: string,
): MarketingGlobalDocument {
  if (!isRecord(payload)) throw invalidPayload(requestId);
  if (
    !Array.isArray(payload['navigation']) ||
    !Array.isArray(payload['footer']) ||
    !Array.isArray(payload['ctas'])
  ) {
    throw invalidPayload(requestId);
  }
  return {
    locale: MARKETING_LOCALE,
    version,
    navigation: payload['navigation'] as MarketingGlobalDocument['navigation'],
    footer: payload['footer'] as MarketingGlobalDocument['footer'],
    ctas: payload['ctas'] as MarketingGlobalDocument['ctas'],
  };
}

function requirePagePayload(
  payload: unknown,
  slug: MarketingPageSlug,
  version: number,
  requestId: string,
): MarketingPageDocument {
  if (!isRecord(payload)) throw invalidPayload(requestId);
  if (
    !Number.isInteger(payload['schemaVersion']) ||
    !Array.isArray(payload['blocks']) ||
    !isRecord(payload['seo'])
  ) {
    throw invalidPayload(requestId);
  }
  return {
    slug,
    locale: MARKETING_LOCALE,
    schemaVersion: Number(payload['schemaVersion']),
    version,
    blocks: payload['blocks'] as MarketingPageDocument['blocks'],
    seo: payload['seo'] as unknown as MarketingPageDocument['seo'],
  };
}

function isMarketingPageSlug(value: string): value is MarketingPageSlug {
  return MARKETING_PAGE_SLUGS.includes(value as MarketingPageSlug);
}

function invalidPayload(requestId: string): ApiError {
  return new ApiError({
    code: 'VALIDATION_FAILED',
    message: 'Payload marketing terbit tidak valid.',
    requestId,
    status: 400,
  });
}

function notFound(requestId: string): ApiError {
  return new ApiError({
    code: 'RESOURCE_NOT_FOUND',
    message: 'Konten marketing tidak ditemukan.',
    requestId,
    status: 404,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortJson(v)]),
  );
}
