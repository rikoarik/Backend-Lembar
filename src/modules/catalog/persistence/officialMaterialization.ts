/**
 * Official catalog materialization (BUG-11/12, kanban t_bb300b60).
 *
 * The Kemendikdasmen snapshot is read-only reference data served straight from
 * the JSON snapshot, but `materials` rows need real FK parents
 * (`outcome_id`/`subject_id`/`phase_id`/`grade_id`/`curriculum_id` are all
 * `uuid NOT NULL` with FKs). So a superadmin creating a material against an
 * official CP has no DB parent to point at.
 *
 * This module materializes the official chain (curriculum → grade → phase →
 * subject → outcome) into the caller's workspace tenant on demand, using the
 * same deterministic codes for every call so the unique indexes make the writes
 * idempotent. Rows are published (`published_version = 1`) so they behave like
 * every other catalog row.
 *
 * Deliberately no explicit transaction: each upsert is individually atomic and
 * idempotent, so a partial failure leaves only already-materialized reference
 * rows behind — never a half-linked material.
 */
import type { Pool } from 'pg';

import type { OfficialSubjectRef } from '../officialCatalog.js';
import { resolveOfficialSubject } from '../officialCatalog.js';

/** Slug of the shared tenant used only when the caller has no workspace. */
export const OFFICIAL_TENANT_SLUG = 'official-kemendikdasmen';
const OFFICIAL_TENANT_NAME = 'Katalog Resmi Kemendikdasmen';

/** Single official curriculum row — one level column cannot describe six levels. */
const OFFICIAL_CURRICULUM_CODE = 'OFFICIAL-CP';
const OFFICIAL_CURRICULUM_SLUG = 'official-kemendikdasmen-cp';
const OFFICIAL_CURRICULUM_TITLE = 'Kurikulum Merdeka — CP resmi Kemendikdasmen';

/** One CP per official subject, so a constant outcome code is enough. */
const OFFICIAL_OUTCOME_CODE = 'CP';
const OFFICIAL_OUTCOME_BLOOM = 'understand';

const LEVEL_TO_CURRICULUM_LEVEL: Record<string, string> = {
  paud: 'other',
  'sd-mi': 'sd',
  'smp-mts': 'smp',
  'sma-ma': 'sma',
  smk: 'smk',
  slb: 'other',
};

function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export interface OfficialChainIds {
  curriculumId: string;
  gradeId: string;
  phaseId: string;
  subjectId: string;
  outcomeId: string;
  tenantId: string;
}

/**
 * Resolve the tenant that should own a materialized official chain: the
 * caller's workspace when it has one, otherwise a shared official tenant
 * created on first use.
 */
async function resolveOfficialTenant(pool: Pool, workspaceId: string | null): Promise<string> {
  if (workspaceId) {
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE id = $1::uuid LIMIT 1`,
      [workspaceId],
    );
    if (existing.rows[0]) return existing.rows[0].id;
  }

  const created = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [OFFICIAL_TENANT_SLUG, OFFICIAL_TENANT_NAME],
  );
  return created.rows[0]!.id;
}

/**
 * Materialize the official chain for `subjectId` and return the parent uuids a
 * `materials` row needs. Throws `OfficialOutcomeNotFound` when the id is not a
 * known official subject.
 */
export async function materializeOfficialOutcome(
  pool: Pool,
  subjectId: string,
  workspaceId: string | null,
): Promise<OfficialChainIds> {
  const ref = resolveOfficialSubject(subjectId);
  if (!ref) throw new OfficialOutcomeNotFound(subjectId);
  return materializeOfficialRef(pool, ref, workspaceId);
}

export class OfficialOutcomeNotFound extends Error {
  constructor(readonly subjectId: string) {
    super(`Official outcome '${subjectId}' tidak ditemukan pada katalog resmi.`);
    this.name = 'OfficialOutcomeNotFound';
  }
}

async function materializeOfficialRef(
  pool: Pool,
  ref: OfficialSubjectRef,
  workspaceId: string | null,
): Promise<OfficialChainIds> {
  const tenantId = await resolveOfficialTenant(pool, workspaceId);
  const { record, grade } = ref;

  const curriculum = await pool.query<{ id: string }>(
    `INSERT INTO curricula (tenant_id, slug, code, title, level, active, published_version)
     VALUES ($1, $2, $3, $4, $5, true, 1)
     ON CONFLICT (tenant_id, code) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [
      tenantId,
      OFFICIAL_CURRICULUM_SLUG,
      OFFICIAL_CURRICULUM_CODE,
      OFFICIAL_CURRICULUM_TITLE,
      LEVEL_TO_CURRICULUM_LEVEL[record.level] ?? 'other',
    ],
  );
  const curriculumId = curriculum.rows[0]!.id;

  const gradeCode = `official-grade-${slug(grade.id)}`;
  const gradeRow = await pool.query<{ id: string }>(
    `INSERT INTO grades (curriculum_id, tenant_id, code, label, ordering, published_version)
     VALUES ($1, $2, $3, $4, 0, 1)
     ON CONFLICT (curriculum_id, code) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [curriculumId, tenantId, gradeCode, grade.label],
  );
  const gradeId = gradeRow.rows[0]!.id;

  const phaseCode = `official-phase-${slug(record.level)}-${slug(record.phase)}`;
  const phaseRow = await pool.query<{ id: string }>(
    `INSERT INTO phases (grade_id, curriculum_id, tenant_id, code, label, ordering, published_version)
     VALUES ($1, $2, $3, $4, $5, 0, 1)
     ON CONFLICT (grade_id, code) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [
      gradeId,
      curriculumId,
      tenantId,
      phaseCode,
      record.phase === 'Fondasi' ? 'Fase Fondasi' : `Fase ${record.phase}`,
    ],
  );
  const phaseId = phaseRow.rows[0]!.id;

  const subjectCode = `official-subject-${slug(record.level)}-${slug(record.phase)}-${slug(record.subject)}`;
  const subjectRow = await pool.query<{ id: string }>(
    `INSERT INTO subjects (phase_id, grade_id, curriculum_id, tenant_id, code, title, ordering, published_version)
     VALUES ($1, $2, $3, $4, $5, $6, 0, 1)
     ON CONFLICT (phase_id, code) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [phaseId, gradeId, curriculumId, tenantId, subjectCode, record.label],
  );
  const subjectUuid = subjectRow.rows[0]!.id;

  const outcomeRow = await pool.query<{ id: string }>(
    `INSERT INTO outcomes (subject_id, phase_id, grade_id, curriculum_id, tenant_id, code, text, bloom_level, ordering, published_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 1)
     ON CONFLICT (subject_id, code) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [
      subjectUuid,
      phaseId,
      gradeId,
      curriculumId,
      tenantId,
      OFFICIAL_OUTCOME_CODE,
      ref.cpLabel,
      OFFICIAL_OUTCOME_BLOOM,
    ],
  );

  return {
    curriculumId,
    gradeId,
    phaseId,
    subjectId: subjectUuid,
    outcomeId: outcomeRow.rows[0]!.id,
    tenantId,
  };
}

/**
 * Best-effort lookup of an already-materialized official chain, used by the
 * read paths to resolve official slug ids to the uuids a material was stored
 * under. Returns null when nothing has been materialized for that workspace yet.
 */
export async function findMaterializedOfficialChain(
  pool: Pool,
  subjectId: string,
  workspaceId: string | null,
): Promise<OfficialChainIds | null> {
  const ref = resolveOfficialSubject(subjectId);
  if (!ref) return null;

  const tenantId = workspaceId
    ? ((
        await pool.query<{ id: string }>(`SELECT id FROM tenants WHERE id = $1::uuid LIMIT 1`, [
          workspaceId,
        ])
      ).rows[0]?.id ?? null)
    : ((
        await pool.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = $1 LIMIT 1`, [
          OFFICIAL_TENANT_SLUG,
        ])
      ).rows[0]?.id ?? null);
  if (!tenantId) return null;

  const subjectCode = `official-subject-${slug(ref.record.level)}-${slug(ref.record.phase)}-${slug(ref.record.subject)}`;
  const row = await pool.query<{
    subject_id: string;
    phase_id: string;
    grade_id: string;
    curriculum_id: string;
    outcome_id: string;
  }>(
    `SELECT s.id AS subject_id, s.phase_id, s.grade_id, s.curriculum_id, o.id AS outcome_id
       FROM subjects s
       LEFT JOIN outcomes o ON o.subject_id = s.id AND o.code = $3
      WHERE s.tenant_id = $1::uuid AND s.code = $2
      LIMIT 1`,
    [tenantId, subjectCode, OFFICIAL_OUTCOME_CODE],
  );
  const found = row.rows[0];
  if (!found?.outcome_id) return null;

  return {
    curriculumId: found.curriculum_id,
    gradeId: found.grade_id,
    phaseId: found.phase_id,
    subjectId: found.subject_id,
    outcomeId: found.outcome_id,
    tenantId,
  };
}

/** True when `value` is a well-formed uuid, i.e. safe to pass to a `uuid` column. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
