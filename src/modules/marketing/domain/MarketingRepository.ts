import { createHash } from 'node:crypto';

import { ApiError } from '../../../common/errors/envelope.js';
import { getPool, type Database } from '../../../infrastructure/database/db.js';
import {
  MARKETING_GLOBAL_SLUG,
  MARKETING_LOCALE,
  MARKETING_PAGE_SLUGS,
  type MarketingBlock,
  type MarketingBlockItem,
  type MarketingCta,
  type MarketingGlobalDocument,
  type MarketingPageDocument,
  type MarketingPageSlug,
  type MarketingSeo,
  type PublishedMarketing,
} from './MarketingContent.js';

const CTA_VARIANTS = new Set<MarketingCta['variant']>(['primary', 'secondary', 'text']);
const CTA_AUDIENCES = new Set<MarketingCta['audience']>(['all', 'teacher', 'school']);
const BLOCK_TYPES = new Set<MarketingBlock['type']>([
  'hero',
  'product_proof',
  'workflow',
  'audience',
  'trust',
  'pricing',
  'faq',
  'final_cta',
]);
const BLOCK_THEMES = new Set<NonNullable<MarketingBlock['theme']>>(['light', 'dark', 'accent']);
const MAX_ID = 80;
const MAX_LABEL = 120;
const MAX_HREF = 500;
const MAX_PLACEMENT = 80;
const MAX_TRACKING_KEY = 100;
const MAX_ACCESSIBLE_LABEL = 160;
const MAX_ITEM_TITLE = 200;
const MAX_ITEM_BODY = 2000;
const MAX_EYEBROW = 120;
const MAX_HEADING = 300;
const MAX_BLOCK_BODY = 4000;
const MAX_SEO_TITLE = 70;
const MAX_SEO_DESCRIPTION = 180;
const MAX_BLOCKS = 20;
const MAX_ITEMS = 20;
const MAX_CTAS = 4;
const GLOBAL_KEYS = new Set(['navigation', 'footer', 'ctas']);
const PAGE_KEYS = new Set(['schemaVersion', 'blocks', 'seo']);
const BLOCK_KEYS = new Set([
  'id',
  'type',
  'eyebrow',
  'heading',
  'body',
  'theme',
  'mediaAssetId',
  'ctas',
  'items',
]);
const ITEM_KEYS = new Set(['id', 'title', 'body', 'mediaAssetId', 'cta']);
const CTA_KEYS = new Set([
  'id',
  'label',
  'href',
  'variant',
  'placement',
  'audience',
  'trackingKey',
  'enabled',
  'external',
  'accessibleLabel',
]);
const SEO_KEYS = new Set(['title', 'description', 'imageAssetId', 'noIndex']);

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
  const source = requireRecord(payload, requestId);
  assertExactKeys(source, GLOBAL_KEYS, requestId);
  return {
    locale: MARKETING_LOCALE,
    version,
    navigation: requireItemsArray(source['navigation'], requestId),
    footer: requireItemsArray(source['footer'], requestId),
    ctas: requireCtasArray(source['ctas'], requestId),
  };
}

function requirePagePayload(
  payload: unknown,
  slug: MarketingPageSlug,
  version: number,
  requestId: string,
): MarketingPageDocument {
  const source = requireRecord(payload, requestId);
  assertExactKeys(source, PAGE_KEYS, requestId);
  return {
    slug,
    locale: MARKETING_LOCALE,
    schemaVersion: requireInteger(source['schemaVersion'], requestId, { min: 1 }),
    version,
    blocks: requireBlocksArray(source['blocks'], requestId),
    seo: requireSeo(source['seo'], requestId),
  };
}

function requireBlocksArray(value: unknown, requestId: string): MarketingBlock[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BLOCKS) {
    throw invalidPayload(requestId);
  }
  return value.map((entry) => requireBlock(entry, requestId));
}

function requireBlock(value: unknown, requestId: string): MarketingBlock {
  const source = requireRecord(value, requestId);
  assertExactKeys(source, BLOCK_KEYS, requestId);
  const type = requireEnum(source['type'], BLOCK_TYPES, requestId);
  const ctas =
    source['ctas'] === undefined ? undefined : requireCtasArray(source['ctas'], requestId);
  const items =
    source['items'] === undefined ? undefined : requireItemsArray(source['items'], requestId);
  return {
    id: requireString(source['id'], requestId, { min: 1, max: MAX_ID }),
    type,
    ...(source['eyebrow'] === undefined
      ? {}
      : { eyebrow: requireNullableString(source['eyebrow'], requestId, { max: MAX_EYEBROW }) }),
    ...(source['heading'] === undefined
      ? {}
      : { heading: requireNullableString(source['heading'], requestId, { max: MAX_HEADING }) }),
    ...(source['body'] === undefined
      ? {}
      : { body: requireNullableString(source['body'], requestId, { max: MAX_BLOCK_BODY }) }),
    ...(source['theme'] === undefined
      ? {}
      : { theme: requireEnum(source['theme'], BLOCK_THEMES, requestId) }),
    ...(source['mediaAssetId'] === undefined
      ? {}
      : {
          mediaAssetId: requireNullableString(source['mediaAssetId'], requestId, {
            min: 1,
            max: MAX_ID,
          }),
        }),
    ...(ctas === undefined ? {} : { ctas }),
    ...(items === undefined ? {} : { items }),
  };
}

function requireItemsArray(value: unknown, requestId: string): MarketingBlockItem[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw invalidPayload(requestId);
  return value.map((entry) => requireItem(entry, requestId));
}

function requireItem(value: unknown, requestId: string): MarketingBlockItem {
  const source = requireRecord(value, requestId);
  assertExactKeys(source, ITEM_KEYS, requestId);
  return {
    id: requireString(source['id'], requestId, { min: 1, max: MAX_ID }),
    title: requireString(source['title'], requestId, { min: 1, max: MAX_ITEM_TITLE }),
    ...(source['body'] === undefined
      ? {}
      : { body: requireNullableString(source['body'], requestId, { max: MAX_ITEM_BODY }) }),
    ...(source['mediaAssetId'] === undefined
      ? {}
      : {
          mediaAssetId: requireNullableString(source['mediaAssetId'], requestId, {
            min: 1,
            max: MAX_ID,
          }),
        }),
    ...(source['cta'] === undefined
      ? {}
      : {
          cta: source['cta'] === null ? null : requireCta(source['cta'], requestId),
        }),
  };
}

function requireCtasArray(value: unknown, requestId: string): MarketingCta[] {
  if (!Array.isArray(value) || value.length > MAX_CTAS) throw invalidPayload(requestId);
  return value.map((entry) => requireCta(entry, requestId));
}

function requireCta(value: unknown, requestId: string): MarketingCta {
  const source = requireRecord(value, requestId);
  assertExactKeys(source, CTA_KEYS, requestId);
  return {
    id: requireString(source['id'], requestId, { min: 1, max: MAX_ID }),
    label: requireString(source['label'], requestId, { min: 1, max: MAX_LABEL }),
    href: requireHref(source['href'], requestId),
    variant: requireEnum(source['variant'], CTA_VARIANTS, requestId),
    placement: requireString(source['placement'], requestId, { min: 1, max: MAX_PLACEMENT }),
    audience: requireEnum(source['audience'], CTA_AUDIENCES, requestId),
    trackingKey: requireString(source['trackingKey'], requestId, { min: 1, max: MAX_TRACKING_KEY }),
    enabled: requireBoolean(source['enabled'], requestId),
    ...(source['external'] === undefined
      ? {}
      : { external: requireBoolean(source['external'], requestId) }),
    ...(source['accessibleLabel'] === undefined
      ? {}
      : {
          accessibleLabel: requireNullableString(source['accessibleLabel'], requestId, {
            max: MAX_ACCESSIBLE_LABEL,
          }),
        }),
  };
}

function requireSeo(value: unknown, requestId: string): MarketingSeo {
  const source = requireRecord(value, requestId);
  assertExactKeys(source, SEO_KEYS, requestId);
  return {
    title: requireString(source['title'], requestId, { min: 1, max: MAX_SEO_TITLE }),
    description: requireString(source['description'], requestId, {
      min: 1,
      max: MAX_SEO_DESCRIPTION,
    }),
    ...(source['imageAssetId'] === undefined
      ? {}
      : {
          imageAssetId: requireNullableString(source['imageAssetId'], requestId, {
            min: 1,
            max: MAX_ID,
          }),
        }),
    ...(source['noIndex'] === undefined
      ? {}
      : { noIndex: requireBoolean(source['noIndex'], requestId) }),
  };
}

function requireRecord(value: unknown, requestId: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidPayload(requestId);
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  requestId: string,
  bounds: { min?: number; max: number },
): string {
  if (typeof value !== 'string') throw invalidPayload(requestId);
  const trimmed = value.trim();
  if ((bounds.min ?? 0) > trimmed.length || trimmed.length > bounds.max)
    throw invalidPayload(requestId);
  return trimmed;
}

function requireNullableString(
  value: unknown,
  requestId: string,
  bounds: { min?: number; max: number },
): string | null {
  if (value === null) return null;
  return requireString(value, requestId, bounds);
}

function requireBoolean(value: unknown, requestId: string): boolean {
  if (typeof value !== 'boolean') throw invalidPayload(requestId);
  return value;
}

function requireInteger(
  value: unknown,
  requestId: string,
  bounds: { min?: number; max?: number },
): number {
  if (!Number.isInteger(value)) throw invalidPayload(requestId);
  const number = Number(value);
  if (
    (bounds.min !== undefined && number < bounds.min) ||
    (bounds.max !== undefined && number > bounds.max)
  ) {
    throw invalidPayload(requestId);
  }
  return number;
}

function requireEnum<T extends string>(value: unknown, allowed: Set<T>, requestId: string): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) throw invalidPayload(requestId);
  return value as T;
}

function requireHref(value: unknown, requestId: string): string {
  const href = requireString(value, requestId, { min: 1, max: MAX_HREF });
  if (href.startsWith('/')) return href;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    throw invalidPayload(requestId);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw invalidPayload(requestId);
  return href;
}

function assertExactKeys(
  source: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  requestId: string,
): void {
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw invalidPayload(requestId);
  }
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

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortJson(v)]),
  );
}
