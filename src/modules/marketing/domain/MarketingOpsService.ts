import { ApiError } from '../../../common/errors/envelope.js';
import { and, eq } from 'drizzle-orm';
import { getPool, type Database } from '../../../infrastructure/database/db.js';
import {
  marketingContent,
  marketingContentVersions,
} from '../../../infrastructure/database/schema.js';
import { PERMISSIONS, type Permission } from '../../../modules/auth/policy/Permissions.js';

export interface MarketingOpsSummary {
  slug: string;
  locale: string;
  state: 'draft' | 'published' | 'unpublished';
  revision: number;
  publishedVersion: number | null;
  updatedAt: Date | string;
}

export interface MarketingOpsPage {
  summary: MarketingOpsSummary;
  draft: { schemaVersion: number; blocks: unknown[]; seo: unknown } | null;
  versions: MarketingOpsSummary[];
}

export interface MarketingOpsServiceOptions {
  requirePermission: (permission: Permission) => void;
  audit: (action: string, pageId: string, userId: string, version?: number) => void;
  now: () => Date;
}

export class MarketingOpsService {
  private readonly requirePermission: (permission: Permission) => void;
  private readonly audit: (
    action: string,
    pageId: string,
    userId: string,
    version?: number,
  ) => void;
  private readonly now: () => Date;
  private db!: Database;

  constructor(options: MarketingOpsServiceOptions) {
    this.requirePermission = options.requirePermission;
    this.audit = options.audit;
    this.now = options.now ?? (() => new Date());
  }

  withDb(db: Database): this {
    this.db = db;
    return this;
  }

  private pool() {
    const p = getPool(this.db);
    if (!p) throw new Error('database handle has no managed pool');
    return p;
  }

  async listPages(): Promise<MarketingOpsSummary[]> {
    this.requirePermission(PERMISSIONS.platformSupportAct);
    const rows = await this.db
      .select()
      .from(marketingContent)
      .where(eq(marketingContent.kind, 'page'))
      .execute();
    return rows.map((row) => this.summaryFromRow(row));
  }

  async getPageForOps(slug: string): Promise<MarketingOpsPage> {
    this.requirePermission(PERMISSIONS.platformSupportAct);
    const [page] = await this.db
      .select()
      .from(marketingContent)
      .where(and(eq(marketingContent.slug, slug), eq(marketingContent.kind, 'page')))
      .execute();
    if (!page) throw notFound();
    const versions = await this.db
      .select()
      .from(marketingContentVersions)
      .where(eq(marketingContentVersions.contentId, page.id))
      .execute();
    const draft = parseJsonb(page.draftPayload) as MarketingOpsPage['draft'];
    return {
      summary: this.summaryFromRow(page),
      draft,
      versions: versions.map((v) => ({
        slug: page.slug,
        locale: page.locale,
        state: page.publishedVersion === v.version ? 'published' : 'draft',
        revision: Number(v.revision),
        publishedVersion: page.publishedVersion === v.version ? v.version : null,
        updatedAt: v.publishedAt,
      })),
    };
  }

  async saveDraft(
    slug: string,
    payload: { schemaVersion: number; blocks: unknown[]; seo: unknown },
    revision: number,
    userId: string,
  ): Promise<MarketingOpsPage> {
    this.requirePermission(PERMISSIONS.platformSupportAct);
    const [page] = await this.db
      .select()
      .from(marketingContent)
      .where(and(eq(marketingContent.slug, slug), eq(marketingContent.kind, 'page')))
      .execute();
    if (!page) throw notFound();
    if (page.revision !== revision) {
      throw new ApiError({
        code: 'STATE_CONFLICT',
        message: 'CMS_REVISION_CONFLICT',
        requestId: 'req_marketing',
        status: 409,
      });
    }
    const draftJson = JSON.stringify(payload);
    if (draftJson.length > 100_000) {
      throw new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'Draft melebihi batas ukuran.',
        requestId: 'req_marketing',
        status: 400,
      });
    }
    const newRevision = page.revision + 1;
    const now = this.now();
    await this.pool().query(
      `UPDATE marketing_content
       SET draft_payload = $1::jsonb, revision = $2, updated_by = $3, updated_at = $4
       WHERE id = $5`,
      [draftJson, newRevision, userId, now, page.id],
    );
    this.audit('draft_saved', page.id, userId, newRevision);
    return this.getPageForOps(slug);
  }

  async preview(
    slug: string,
  ): Promise<{ schemaVersion: number; blocks: unknown[]; seo: unknown } | null> {
    this.requirePermission(PERMISSIONS.platformSupportAct);
    const [page] = await this.db
      .select()
      .from(marketingContent)
      .where(and(eq(marketingContent.slug, slug), eq(marketingContent.kind, 'page')))
      .execute();
    if (!page) throw notFound();
    this.audit('preview_rendered', page.id, 'system');
    return parseJsonb(page.draftPayload) as MarketingOpsPage['draft'];
  }

  async publish(slug: string, revision: number, userId: string): Promise<MarketingOpsPage> {
    this.requirePermission(PERMISSIONS.platformSupportAct);
    const [page] = await this.db
      .select()
      .from(marketingContent)
      .where(and(eq(marketingContent.slug, slug), eq(marketingContent.kind, 'page')))
      .execute();
    if (!page) throw notFound();
    if (!page.draftPayload) {
      throw new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'Tidak ada draft untuk diterbitkan.',
        requestId: 'req_marketing',
        status: 400,
      });
    }
    if (page.revision !== revision) {
      throw new ApiError({
        code: 'STATE_CONFLICT',
        message: 'CMS_REVISION_CONFLICT',
        requestId: 'req_marketing',
        status: 409,
      });
    }
    const newVersion = (page.publishedVersion ?? 0) + 1;
    const newRevision = page.revision + 1;
    const now = this.now();
    await this.db.transaction(async () => {
      const injectedDraft = await this.db
        .insert(marketingContentVersions)
        .values({
          contentId: page.id,
          version: newVersion,
          payload: JSON.stringify(parseJsonb(page.draftPayload)),
          revision: newRevision,
          publishedAt: now,
        })
        .returning();
      await this.db
        .update(marketingContent)
        .set({
          currentVersion: newVersion,
          publishedVersion: newVersion,
          revision: newRevision,
          state: 'published',
          updatedBy: userId,
          updatedAt: now,
        })
        .where(eq(marketingContent.id, page.id));
      this.audit('published', page.id, userId, newVersion);
    });
    return this.getPageForOps(slug);
  }

  async unpublish(slug: string, revision: number, userId: string): Promise<MarketingOpsPage> {
    this.requirePermission(PERMISSIONS.platformSupportAct);
    const [page] = await this.db
      .select()
      .from(marketingContent)
      .where(and(eq(marketingContent.slug, slug), eq(marketingContent.kind, 'page')))
      .execute();
    if (!page) throw notFound();
    if (page.revision !== revision) {
      throw new ApiError({
        code: 'STATE_CONFLICT',
        message: 'CMS_REVISION_CONFLICT',
        requestId: 'req_marketing',
        status: 409,
      });
    }
    const newRevision = page.revision + 1;
    const now = this.now();
    await this.pool().query(
      `UPDATE marketing_content
       SET state = 'unpublished', published_version = NULL, revision = $1, updated_by = $2, updated_at = $3
       WHERE id = $4`,
      [newRevision, userId, now, page.id],
    );
    this.audit('unpublished', page.id, userId, page.publishedVersion ?? undefined);
    return this.getPageForOps(slug);
  }

  async restore(slug: string, version: number, userId: string): Promise<MarketingOpsPage> {
    this.requirePermission(PERMISSIONS.platformSupportAct);
    const [page] = await this.db
      .select()
      .from(marketingContent)
      .where(and(eq(marketingContent.slug, slug), eq(marketingContent.kind, 'page')))
      .execute();
    if (!page) throw notFound();
    const { rows } = await this.pool().query(
      `SELECT payload FROM marketing_content_versions
       WHERE content_id = $1 AND version = $2 LIMIT 1`,
      [page.id, version],
    );
    if (!rows[0]) throw notFound();
    const newRevision = page.revision + 1;
    const now = this.now();
    await this.pool().query(
      `UPDATE marketing_content
       SET draft_payload = $1::jsonb, revision = $2, updated_by = $3, updated_at = $4
       WHERE id = $5`,
      [JSON.stringify(rows[0].payload), newRevision, userId, now, page.id],
    );
    this.audit('restored', page.id, userId, version);
    return this.getPageForOps(slug);
  }

  private summaryFromRow(row: typeof marketingContent.$inferSelect): MarketingOpsSummary {
    return {
      slug: row.slug,
      locale: row.locale,
      state: row.state,
      revision: Number(row.revision),
      publishedVersion: row.publishedVersion,
      updatedAt: row.updatedAt as unknown as string,
    };
  }
}

function notFound(): ApiError {
  return new ApiError({
    code: 'RESOURCE_NOT_FOUND',
    message: 'Konten marketing tidak ditemukan.',
    requestId: 'req_marketing',
    status: 404,
  });
}

function parseJsonb(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}
