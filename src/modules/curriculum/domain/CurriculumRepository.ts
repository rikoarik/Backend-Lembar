import { createHash } from 'node:crypto';

import { getPool, type Database } from '../../../infrastructure/database/db.js';

export type ResourceKey = 'curricula' | 'grades' | 'phases' | 'subjects' | 'outcomes' | 'materials';

interface ResourceDef {
  table: string;
  versionTable: string;
  versionFk: string;
  columns: readonly string[];
  createRequired: readonly string[];
  parent?: { key: string; column: string; table: string };
}

export interface HeadRow {
  id: string;
  tenantId: string;
  currentVersion: number;
  publishedVersion: number | null;
  payload: Record<string, unknown>;
}

export interface VersionRow {
  id: string;
  version: number;
  payload: Record<string, unknown>;
  publishedAt: string;
  publishedBy: string | null;
}

export interface CatalogProjection {
  curriculum: Record<string, unknown>;
  grades: Record<string, unknown>[];
  phases: Record<string, unknown>[];
  subjects: Record<string, unknown>[];
  outcomes: Record<string, unknown>[];
  materials: Record<string, unknown>[];
}

export const RESOURCES: Record<ResourceKey, ResourceDef> = {
  curricula: {
    table: 'curricula',
    versionTable: 'curriculum_versions',
    versionFk: 'curriculum_id',
    columns: ['slug', 'code', 'title', 'description', 'level', 'active'],
    createRequired: ['tenant_id', 'slug', 'code', 'title', 'level'],
  },
  grades: {
    table: 'grades',
    versionTable: 'grade_versions',
    versionFk: 'grade_id',
    columns: ['curriculum_id', 'code', 'label', 'ordering'],
    createRequired: ['curriculum_id', 'code', 'label'],
    parent: { key: 'curriculumId', column: 'curriculum_id', table: 'curricula' },
  },
  phases: {
    table: 'phases',
    versionTable: 'phase_versions',
    versionFk: 'phase_id',
    columns: ['grade_id', 'curriculum_id', 'code', 'label', 'ordering'],
    createRequired: ['grade_id', 'code', 'label'],
    parent: { key: 'gradeId', column: 'grade_id', table: 'grades' },
  },
  subjects: {
    table: 'subjects',
    versionTable: 'subject_versions',
    versionFk: 'subject_id',
    columns: ['phase_id', 'grade_id', 'curriculum_id', 'code', 'title', 'ordering'],
    createRequired: ['phase_id', 'code', 'title'],
    parent: { key: 'phaseId', column: 'phase_id', table: 'phases' },
  },
  outcomes: {
    table: 'outcomes',
    versionTable: 'outcome_versions',
    versionFk: 'outcome_id',
    columns: [
      'subject_id',
      'phase_id',
      'grade_id',
      'curriculum_id',
      'code',
      'text',
      'bloom_level',
      'ordering',
    ],
    createRequired: ['subject_id', 'code', 'text', 'bloom_level'],
    parent: { key: 'subjectId', column: 'subject_id', table: 'subjects' },
  },
  materials: {
    table: 'materials',
    versionTable: 'material_versions',
    versionFk: 'material_id',
    columns: [
      'outcome_id',
      'subject_id',
      'phase_id',
      'grade_id',
      'curriculum_id',
      'code',
      'kind',
      'title',
      'source_rights',
      'ordering',
    ],
    createRequired: ['outcome_id', 'code', 'kind', 'title', 'source_rights'],
    parent: { key: 'outcomeId', column: 'outcome_id', table: 'outcomes' },
  },
};

const CAMEL_TO_SNAKE: Record<string, string> = {
  tenantId: 'tenant_id',
  curriculumId: 'curriculum_id',
  gradeId: 'grade_id',
  phaseId: 'phase_id',
  subjectId: 'subject_id',
  outcomeId: 'outcome_id',
  bloomLevel: 'bloom_level',
  sourceRights: 'source_rights',
  publishedVersion: 'published_version',
  currentVersion: 'current_version',
};

export class CurriculumRepository {
  constructor(private readonly db: Database) {}

  async createDraft(resource: ResourceKey, raw: Record<string, unknown>): Promise<HeadRow> {
    const def = RESOURCES[resource];
    const values = await this.withInheritedTenantAndParents(def, raw);
    for (const field of def.createRequired) {
      if (values[field] === undefined || values[field] === null || values[field] === '') {
        throw new Error(`missing required field ${field}`);
      }
    }
    const columns = ['tenant_id', ...def.columns].filter(
      (c, i, a) => a.indexOf(c) === i && c in values,
    );
    const params = columns.map((c) => values[c]);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const result = await this.query(
      `insert into ${def.table} (${columns.join(', ')}) values (${placeholders}) returning *`,
      params,
    );
    return toHead(def, result.rows[0]);
  }

  async updateDraft(
    resource: ResourceKey,
    id: string,
    raw: Record<string, unknown>,
  ): Promise<HeadRow | null> {
    const def = RESOURCES[resource];
    const values = snakeRecord(raw);
    const columns = def.columns.filter((c) => c in values && !c.endsWith('_id'));
    if (columns.length === 0) {
      const existing = await this.getHead(resource, id);
      return existing;
    }
    const sets = columns.map((c, i) => `${c} = $${i + 1}`);
    const params = columns.map((c) => values[c]);
    const result = await this.query(
      `update ${def.table}
       set ${sets.join(', ')}, current_version = current_version + 1, updated_at = now()
       where id = $${params.length + 1}
       returning *`,
      [...params, id],
    );
    return result.rows[0] ? toHead(def, result.rows[0]) : null;
  }

  async getHead(resource: ResourceKey, id: string): Promise<HeadRow | null> {
    const def = RESOURCES[resource];
    const result = await this.query(`select * from ${def.table} where id = $1 limit 1`, [id]);
    return result.rows[0] ? toHead(def, result.rows[0]) : null;
  }

  async publish(
    resource: ResourceKey,
    id: string,
    publishedBy: string | null = null,
  ): Promise<VersionRow | null> {
    const def = RESOURCES[resource];
    const pool = getPool(this.db);
    if (!pool) throw new Error('database handle has no managed pool');
    const client = await pool.connect();
    try {
      await client.query('begin');
      const headResult = await client.query(`select * from ${def.table} where id = $1 for update`, [
        id,
      ]);
      const head = headResult.rows[0] as Record<string, unknown> | undefined;
      if (!head) {
        await client.query('rollback');
        return null;
      }
      if (
        resource === 'materials' &&
        !isApprovedSourceRights(String(head['source_rights'] ?? ''))
      ) {
        throw new Error('source_rights_not_approved');
      }
      const nextResult = await client.query(
        `select coalesce(max(version), 0) + 1 as version from ${def.versionTable} where ${def.versionFk} = $1`,
        [id],
      );
      const version = Number(nextResult.rows[0]?.version ?? 1);
      const payload = publishedPayload(def, head);
      const inserted = await client.query(
        `insert into ${def.versionTable} (${def.versionFk}, version, payload, published_by)
         values ($1, $2, $3::jsonb, $4)
         returning id, version, payload, published_at, published_by`,
        [id, version, JSON.stringify(payload), publishedBy],
      );
      await client.query(
        `update ${def.table}
         set published_version = $1, current_version = $1, updated_at = now()
         where id = $2`,
        [version, id],
      );
      await client.query('commit');
      return toVersion(inserted.rows[0]);
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  async getVersion(resource: ResourceKey, id: string, version: number): Promise<VersionRow | null> {
    const def = RESOURCES[resource];
    const result = await this.query(
      `select id, version, payload, published_at, published_by
       from ${def.versionTable}
       where ${def.versionFk} = $1 and version = $2
       limit 1`,
      [id, version],
    );
    return result.rows[0] ? toVersion(result.rows[0]) : null;
  }

  async listVersions(resource: ResourceKey, id: string, limit = 20): Promise<VersionRow[]> {
    const def = RESOURCES[resource];
    const capped = Math.min(Math.max(limit, 1), 100);
    const result = await this.query(
      `select id, version, payload, published_at, published_by
       from ${def.versionTable}
       where ${def.versionFk} = $1
       order by version desc
       limit $2`,
      [id, capped],
    );
    return result.rows.map(toVersion);
  }

  async gateSourceRights(
    resource: ResourceKey,
    id: string,
  ): Promise<{ ok: boolean; reason: string | null }> {
    if (resource !== 'materials') return { ok: true, reason: null };
    const head = await this.getHead(resource, id);
    const rights = head?.payload['source_rights'];
    if (typeof rights === 'string' && isApprovedSourceRights(rights))
      return { ok: true, reason: null };
    return { ok: false, reason: 'Hak sumber materi belum disetujui.' };
  }

  async readPublishedCatalogByTenantSlug(tenantSlug: string): Promise<CatalogProjection | null> {
    const tenantResult = await this.query('select id from tenants where slug = $1 limit 1', [
      tenantSlug,
    ]);
    const tenantId = tenantResult.rows[0]?.id as string | undefined;
    if (!tenantId) return null;

    const curriculaResult = await this.query(
      `select c.*, v.payload as version_payload
       from curricula c
       join curriculum_versions v on v.curriculum_id = c.id and v.version = c.published_version
       where c.tenant_id = $1 and c.active = true
       order by c.created_at desc
       limit 1`,
      [tenantId],
    );
    const curriculum = curriculaResult.rows[0] as Record<string, unknown> | undefined;
    if (!curriculum) return null;

    const curriculumId = String(curriculum['id']);
    const [gradeRows, phaseRows, subjectRows, outcomeRows, materialRows] = await Promise.all([
      this.publishedRows(
        'grades',
        'grade_versions',
        'grade_id',
        tenantId,
        'curriculum_id',
        curriculumId,
      ),
      this.publishedRows(
        'phases',
        'phase_versions',
        'phase_id',
        tenantId,
        'curriculum_id',
        curriculumId,
      ),
      this.publishedRows(
        'subjects',
        'subject_versions',
        'subject_id',
        tenantId,
        'curriculum_id',
        curriculumId,
      ),
      this.publishedRows(
        'outcomes',
        'outcome_versions',
        'outcome_id',
        tenantId,
        'curriculum_id',
        curriculumId,
      ),
      this.publishedRows(
        'materials',
        'material_versions',
        'material_id',
        tenantId,
        'curriculum_id',
        curriculumId,
      ),
    ]);

    return {
      curriculum: stripInternal(curriculum),
      grades: gradeRows.map(stripInternal),
      phases: phaseRows.map(stripInternal),
      subjects: subjectRows.map(stripInternal),
      outcomes: outcomeRows.map(stripInternal),
      materials: materialRows.map(stripInternal),
    };
  }

  private async publishedRows(
    table: string,
    versionTable: string,
    fk: string,
    tenantId: string,
    scopeColumn: string,
    scopeId: string,
  ): Promise<Record<string, unknown>[]> {
    const result = await this.query(
      `select h.*, v.payload as version_payload
       from ${table} h
       join ${versionTable} v on v.${fk} = h.id and v.version = h.published_version
       where h.tenant_id = $1 and h.${scopeColumn} = $2
       order by h.ordering asc, h.code asc`,
      [tenantId, scopeId],
    );
    return result.rows as Record<string, unknown>[];
  }

  private async withInheritedTenantAndParents(
    def: ResourceDef,
    raw: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const values = snakeRecord(raw);
    if (!def.parent) return values;
    const parentId = values[def.parent.column];
    if (typeof parentId !== 'string') return values;
    const parent = await this.query(`select * from ${def.parent.table} where id = $1 limit 1`, [
      parentId,
    ]);
    const row = parent.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error('parent row not found');
    values['tenant_id'] = row['tenant_id'];
    for (const col of ['curriculum_id', 'grade_id', 'phase_id', 'subject_id']) {
      if (row[col] !== undefined && values[col] === undefined) values[col] = row[col];
    }
    if (def.table === 'phases') values['curriculum_id'] = row['curriculum_id'];
    if (def.table === 'subjects') {
      values['grade_id'] = row['grade_id'];
      values['curriculum_id'] = row['curriculum_id'];
    }
    if (def.table === 'outcomes') {
      values['phase_id'] = row['phase_id'];
      values['grade_id'] = row['grade_id'];
      values['curriculum_id'] = row['curriculum_id'];
    }
    if (def.table === 'materials') {
      values['subject_id'] = row['subject_id'];
      values['phase_id'] = row['phase_id'];
      values['grade_id'] = row['grade_id'];
      values['curriculum_id'] = row['curriculum_id'];
    }
    return values;
  }

  private async query(text: string, values: unknown[] = []) {
    const pool = getPool(this.db);
    if (!pool) throw new Error('database handle has no managed pool');
    return pool.query(text, values);
  }
}

export function etagForPayload(payload: unknown): string {
  const bytes = stableJson(payload);
  return `"sha256:${createHash('sha256').update(bytes).digest('hex')}"`;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function isApprovedSourceRights(value: string): boolean {
  return value === 'license:internal' || value === 'license:cc-by' || value === 'license:cc-by-sa';
}

function toHead(def: ResourceDef, row: Record<string, unknown>): HeadRow {
  return {
    id: String(row['id']),
    tenantId: String(row['tenant_id']),
    currentVersion: Number(row['current_version']),
    publishedVersion: row['published_version'] === null ? null : Number(row['published_version']),
    payload: publishedPayload(def, row),
  };
}

function toVersion(row: Record<string, unknown>): VersionRow {
  return {
    id: String(row['id']),
    version: Number(row['version']),
    payload: (row['payload'] as Record<string, unknown>) ?? {},
    publishedAt: new Date(String(row['published_at'])).toISOString(),
    publishedBy: (row['published_by'] as string | null) ?? null,
  };
}

function publishedPayload(def: ResourceDef, row: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = { id: row['id'] };
  for (const col of def.columns) payload[col] = row[col];
  return payload;
}

function snakeRecord(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) out[CAMEL_TO_SNAKE[key] ?? key] = value;
  return out;
}

function stripInternal(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (
      key === 'tenant_id' ||
      key === 'current_version' ||
      key === 'created_at' ||
      key === 'updated_at'
    )
      continue;
    out[key === 'published_version' ? 'version' : camel(key)] =
      key === 'version_payload' ? sortJson(value) : value;
  }
  return out;
}

function camel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortJson(v)]),
  );
}
