/**
 * Catalog HTTP routes — OpenAPI: /v1/catalog/grades|subjects|materials
 *
 * Returns CatalogOption[]: { id, label, status }
 * Reads from curriculum tables when available; falls back to seed options.
 *
 * Admin CRUD endpoints (superadmin only):
 *   PATCH /v1/admin/catalog/grades/:id/status
 *   PATCH /v1/admin/catalog/subjects/:id/status
 *   POST  /v1/admin/catalog/grades
 *   POST  /v1/admin/catalog/subjects
 *   DELETE /v1/admin/catalog/grades/:id
 *   DELETE /v1/admin/catalog/subjects/:id
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { and, eq, isNotNull } from 'drizzle-orm';
import { MATERIAL_KINDS, APPROVED_SOURCE_RIGHTS, SOURCE_RIGHTS_VALUES } from '../../../curriculum/persistence/schema.js';
import { randomUUID } from 'node:crypto';

import type { Database } from '../../../../infrastructure/database/db.js';
import { getPool } from '../../../../infrastructure/database/db.js';
import {
  curricula,
  curriculumVersions,
  grades,
  subjects,
  materials,
} from '../../../curriculum/persistence/schema.js';
import {
  createJwtAuthMiddleware,
  requireRole,
} from '../../../../common/middleware/jwtMultiRoleAuth.js';
import {
  OFFICIAL_GRADES,
  OFFICIAL_PHASES,
  listOfficialMaterials,
  listOfficialSubjects,
  resolveOfficialSubject,
} from '../../officialCatalog.js';
import {
  OfficialOutcomeNotFound,
  findMaterializedOfficialChain,
  isUuid,
  materializeOfficialOutcome,
} from '../../persistence/officialMaterialization.js';

export interface CatalogOption {
  id: string;
  label: string;
  status: 'active' | 'archived' | 'unavailable';
}

/**
 * `outcomeId` is the curriculum outcome (CP) a material belongs to. It is
 * optional/additive: DB-backed tenant materials carry the uuid of the
 * `materials.outcome_id` row, official catalog materials carry the derived
 * `<subjectId>-cp` id. Consumers that need to attribute generated content to a
 * curriculum anchor read this field first and may fall back to deriving it from
 * the id shape when it is absent.
 */
export interface CatalogMaterialOption extends CatalogOption {
  outcomeId?: string | null;
}

export interface CatalogGradeOption extends CatalogOption {
  jenjang: 'sd' | 'smp' | 'sma' | 'smk';
}

export interface CatalogSubjectOption extends CatalogOption {
  /** Daftar jenjang yang memiliki mata pelajaran ini */
  jenjangList: ('sd' | 'smp' | 'sma' | 'smk')[];
}

export interface RegisterCatalogRoutesOptions {
  db?: Database | undefined;
  jwtSecret?: string | undefined;
}

// ── Kurikulum Merdeka seed data ────────────────────────────────────────────────

type Jenjang = 'sd' | 'smp' | 'sma' | 'smk';

const FALLBACK_GRADES: CatalogGradeOption[] = [
  // SD (Sekolah Dasar) — 6 kelas
  { id: 'sd-1', label: 'Kelas 1 SD', status: 'active', jenjang: 'sd' },
  { id: 'sd-2', label: 'Kelas 2 SD', status: 'active', jenjang: 'sd' },
  { id: 'sd-3', label: 'Kelas 3 SD', status: 'active', jenjang: 'sd' },
  { id: 'sd-4', label: 'Kelas 4 SD', status: 'active', jenjang: 'sd' },
  { id: 'sd-5', label: 'Kelas 5 SD', status: 'active', jenjang: 'sd' },
  { id: 'sd-6', label: 'Kelas 6 SD', status: 'active', jenjang: 'sd' },
  // SMP (Sekolah Menengah Pertama) — 3 kelas
  { id: 'smp-7', label: 'Kelas 7 SMP', status: 'active', jenjang: 'smp' },
  { id: 'smp-8', label: 'Kelas 8 SMP', status: 'active', jenjang: 'smp' },
  { id: 'smp-9', label: 'Kelas 9 SMP', status: 'active', jenjang: 'smp' },
  // SMA (Sekolah Menengah Atas) — 3 kelas
  { id: 'sma-10', label: 'Kelas 10 SMA', status: 'active', jenjang: 'sma' },
  { id: 'sma-11', label: 'Kelas 11 SMA', status: 'active', jenjang: 'sma' },
  { id: 'sma-12', label: 'Kelas 12 SMA', status: 'active', jenjang: 'sma' },
  // SMK (Sekolah Menengah Kejuruan) — 3 kelas
  { id: 'smk-10', label: 'Kelas 10 SMK', status: 'active', jenjang: 'smk' },
  { id: 'smk-11', label: 'Kelas 11 SMK', status: 'active', jenjang: 'smk' },
  { id: 'smk-12', label: 'Kelas 12 SMK', status: 'active', jenjang: 'smk' },
];

const FALLBACK_SUBJECTS: CatalogSubjectOption[] = [
  // ── Lintas jenjang (SD + SMP + SMA + SMK) ──────────────────────────────────
  {
    id: 'subject-matematika',
    label: 'Matematika',
    status: 'active',
    jenjangList: ['sd', 'smp', 'sma', 'smk'],
  },
  {
    id: 'subject-bahasa-indonesia',
    label: 'Bahasa Indonesia',
    status: 'active',
    jenjangList: ['sd', 'smp', 'sma', 'smk'],
  },
  { id: 'subject-ppkn', label: 'PPKn', status: 'active', jenjangList: ['sd', 'smp', 'sma', 'smk'] },
  { id: 'subject-pjok', label: 'PJOK', status: 'active', jenjangList: ['sd', 'smp', 'sma', 'smk'] },

  // ── SD saja ────────────────────────────────────────────────────────────────
  { id: 'subject-ipa', label: 'IPA', status: 'active', jenjangList: ['sd'] },
  { id: 'subject-ips', label: 'IPS', status: 'active', jenjangList: ['sd'] },
  { id: 'subject-seni-budaya', label: 'Seni Budaya', status: 'active', jenjangList: ['sd'] },
  { id: 'subject-prakarya', label: 'Prakarya', status: 'active', jenjangList: ['sd'] },
  {
    id: 'subject-pai',
    label: 'PAI (Pendidikan Agama Islam)',
    status: 'active',
    jenjangList: ['sd'],
  },

  // ── SMP saja ───────────────────────────────────────────────────────────────
  { id: 'subject-bahasa-inggris', label: 'Bahasa Inggris', status: 'active', jenjangList: ['smp'] },
  { id: 'subject-ipa-smp', label: 'IPA', status: 'active', jenjangList: ['smp'] },
  { id: 'subject-ips-smp', label: 'IPS', status: 'active', jenjangList: ['smp'] },
  { id: 'subject-seni-budaya-smp', label: 'Seni Budaya', status: 'active', jenjangList: ['smp'] },
  { id: 'subject-prakarya-smp', label: 'Prakarya', status: 'active', jenjangList: ['smp'] },
  { id: 'subject-informatika-smp', label: 'Informatika', status: 'active', jenjangList: ['smp'] },
  {
    id: 'subject-pai-smp',
    label: 'PAI (Pendidikan Agama Islam)',
    status: 'active',
    jenjangList: ['smp'],
  },

  // ── SMA saja ───────────────────────────────────────────────────────────────
  {
    id: 'subject-bahasa-inggris-sma',
    label: 'Bahasa Inggris',
    status: 'active',
    jenjangList: ['sma'],
  },
  { id: 'subject-fisika', label: 'Fisika', status: 'active', jenjangList: ['sma'] },
  { id: 'subject-kimia', label: 'Kimia', status: 'active', jenjangList: ['sma'] },
  { id: 'subject-biologi', label: 'Biologi', status: 'active', jenjangList: ['sma'] },
  { id: 'subject-ekonomi', label: 'Ekonomi', status: 'active', jenjangList: ['sma'] },
  { id: 'subject-geografi', label: 'Geografi', status: 'active', jenjangList: ['sma'] },
  { id: 'subject-sosiologi', label: 'Sosiologi', status: 'active', jenjangList: ['sma'] },
  {
    id: 'subject-sejarah-indonesia',
    label: 'Sejarah Indonesia',
    status: 'active',
    jenjangList: ['sma'],
  },
  { id: 'subject-seni-budaya-sma', label: 'Seni Budaya', status: 'active', jenjangList: ['sma'] },
  { id: 'subject-informatika-sma', label: 'Informatika', status: 'active', jenjangList: ['sma'] },
  {
    id: 'subject-pai-sma',
    label: 'PAI (Pendidikan Agama Islam)',
    status: 'active',
    jenjangList: ['sma'],
  },
  { id: 'subject-pkwu', label: 'PKWU', status: 'active', jenjangList: ['sma'] },

  // ── SMK saja ───────────────────────────────────────────────────────────────
  {
    id: 'subject-bahasa-inggris-smk',
    label: 'Bahasa Inggris',
    status: 'active',
    jenjangList: ['smk'],
  },
  { id: 'subject-produktif', label: 'Produktif', status: 'active', jenjangList: ['smk'] },
  {
    id: 'subject-kompetensi-keahlian',
    label: 'Kompetensi Keahlian',
    status: 'active',
    jenjangList: ['smk'],
  },
  {
    id: 'subject-pai-smk',
    label: 'PAI (Pendidikan Agama Islam)',
    status: 'active',
    jenjangList: ['smk'],
  },
];

const FALLBACK_CURRICULA = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    curriculumVersionId: '11111111-1111-1111-1111-111111111111',
    curriculumId: '11111111-1111-1111-1111-111111111111',
    label: 'Kurikulum Merdeka',
    version: 1,
    status: 'active' as const,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? req.requestId ?? 'req_unknown';
}

function validationError(reply: FastifyReply, message: string, requestId: string) {
  return reply.status(400).send({
    error: {
      code: 'VALIDATION_FAILED',
      message,
      requestId,
      retryable: false,
    },
  });
}

function notFoundError(reply: FastifyReply, message: string, requestId: string) {
  return reply.status(404).send({
    error: {
      code: 'NOT_FOUND',
      message,
      requestId,
      retryable: false,
    },
  });
}

/** Generate a URL-safe slug from a label, e.g. "Kelas 10" → "kelas-10" */
function labelToSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const VALID_STATUSES = ['active', 'archived', 'unavailable'] as const;
type CatalogStatus = (typeof VALID_STATUSES)[number];

function isValidStatus(v: unknown): v is CatalogStatus {
  return VALID_STATUSES.includes(v as CatalogStatus);
}

/**
 * Resolve jenjang from a gradeId like 'sd-1' → 'sd', 'smp-7' → 'smp', etc.
 */
function jenjangFromGradeId(gradeId: string): Jenjang | null {
  if (gradeId.startsWith('sd-')) return 'sd';
  if (gradeId.startsWith('smp-')) return 'smp';
  if (gradeId.startsWith('sma-')) return 'sma';
  if (gradeId.startsWith('smk-')) return 'smk';
  return null;
}

/** Best-effort audit log — uses raw pool like adminRoutes.ts */
async function auditLog(
  db: Database | undefined,
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  if (!db) return;
  const pool = getPool(db);
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO admin_audit (actor_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [actorId, action, targetType, targetId, JSON.stringify(metadata)],
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Derive the official subject id from an official CP outcome id
 * (`<officialSubjectId>-cp` → `<officialSubjectId>`). Returns null when the id is
 * not an official CP id, so callers can treat it as "not found" rather than
 * sending a non-uuid value to a `uuid` column.
 */
function officialSubjectIdFromOutcomeId(outcomeId: string): string | null {
  if (!outcomeId.endsWith('-cp')) return null;
  const subjectId = outcomeId.slice(0, -'-cp'.length);
  return resolveOfficialSubject(subjectId) ? subjectId : null;
}

/**
 * Grade options for a caller: the official snapshot grades plus any published
 * grade rows owned by the caller's tenant. Shared by the public and admin read
 * routes so both surfaces can never drift apart.
 */
async function listGradesFor(db: Database | undefined, request: FastifyRequest): Promise<unknown[]> {
  const tenantId = request.jwtUser?.workspaceId;
  if (db && tenantId) {
    try {
      const rows = await db
        .select({
          id: grades.id,
          label: grades.label,
          publishedVersion: grades.publishedVersion,
          tenantId: grades.tenantId,
        })
        .from(grades)
        .where(and(eq(grades.tenantId, tenantId), isNotNull(grades.publishedVersion)));

      if (rows.length > 0) {
        return [
          ...OFFICIAL_GRADES,
          ...rows
            .filter((r) => r.tenantId === tenantId)
            .filter((r) => !OFFICIAL_GRADES.some((grade) => grade.id === r.id))
            .map((r) => ({ id: r.id, label: r.label, status: 'active' as const })),
        ];
      }
    } catch {
      // fall through to the official catalog
    }
  }
  return OFFICIAL_GRADES;
}

/**
 * Subject options for a grade. Official grades resolve straight from the
 * snapshot; tenant grade uuids resolve from the DB and fall back to the legacy
 * jenjang-filtered seed list. Shared by the public and admin read routes.
 */
async function listSubjectsFor(
  db: Database | undefined,
  gradeId: string,
  request: FastifyRequest,
): Promise<unknown[]> {
  const tenantId = request.jwtUser?.workspaceId;
  if (db && tenantId) {
    try {
      const rows = await db
        .select({
          id: subjects.id,
          label: subjects.title,
          publishedVersion: subjects.publishedVersion,
          tenantId: subjects.tenantId,
        })
        .from(subjects)
        .where(
          and(
            eq(subjects.tenantId, tenantId),
            eq(subjects.gradeId, gradeId),
            isNotNull(subjects.publishedVersion),
          ),
        );

      if (rows.length > 0) {
        return rows
          .filter((r) => r.tenantId === tenantId)
          .map((r) => ({
            id: r.id,
            label: r.label,
            gradeId,
            status: 'active' as const,
          }));
      }
    } catch {
      // fall through
    }
  }

  const official = listOfficialSubjects(gradeId);
  if (official.length > 0) return official;

  // Legacy fallback: filter subjects by jenjang from gradeId
  const jenjang = jenjangFromGradeId(gradeId);
  const filtered = jenjang
    ? FALLBACK_SUBJECTS.filter((s) => s.jenjangList.includes(jenjang))
    : FALLBACK_SUBJECTS;

  return filtered.map((s) => ({
    id: s.id,
    label: s.label,
    gradeId,
    status: s.status,
  }));
}

/**
 * Pure CP-option resolution for an official subject slug — no DB access, so it
 * is unit-testable and cannot be the source of the `uuid` syntax 500. The DB
 * lookup that upgrades this to the materialized outcome uuid lives in
 * `listOutcomeOptions`.
 */
export function officialOutcomeOption(subjectId: string): { id: string; label: string }[] {
  const ref = resolveOfficialSubject(subjectId);
  if (!ref) return [];
  return [{ id: ref.cpId, label: `CP — ${ref.cpLabel}` }];
}

/**
 * CP/outcome options for a subject id. Tenant subject uuids read from the
 * `outcomes` table; official subject slugs (`official-subject-…`) have no rows
 * until something is materialized, so they answer straight from the snapshot.
 *
 * The id is never interpolated into a `uuid` column unless it is a real uuid —
 * that mismatch was the original 500 (`invalid input syntax for type uuid`).
 */
async function listOutcomeOptions(
  pool: Pool,
  subjectId: string,
  workspaceId: string | null,
): Promise<{ id: string; label: string }[]> {
  if (isUuid(subjectId)) {
    const result = await pool.query<{ id: string; code: string; text: string }>(
      `SELECT id, code, text FROM outcomes WHERE subject_id = $1::uuid ORDER BY ordering, code`,
      [subjectId],
    );
    return result.rows.map((row) => ({ id: row.id, label: `${row.code} — ${row.text}` }));
  }

  const ref = resolveOfficialSubject(subjectId);
  if (!ref) return [];

  // Once a material has been created against this CP the chain exists in the
  // DB; reuse the real uuid so a second material attaches to the same outcome
  // instead of materializing a parallel one.
  const existing = await findMaterializedOfficialChain(pool, subjectId, workspaceId);
  if (existing) {
    return [{ id: existing.outcomeId, label: `CP — ${ref.cpLabel}` }];
  }

  return officialOutcomeOption(subjectId);
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerCatalogRoutes(
  app: FastifyInstance,
  options: RegisterCatalogRoutesOptions = {},
): Promise<void> {
  const db = options.db;

  // Build auth middlewares only when jwtSecret is available
  const auth = options.jwtSecret
    ? createJwtAuthMiddleware({ secret: options.jwtSecret, db: options.db })
    : null;
  const superadmin = requireRole(['superadmin']);

  // Guard: used as preHandler array for admin routes
  const adminGuard = auth ? [auth, superadmin] : [superadmin];

  // ── Public read endpoints ──────────────────────────────────────────────────

  app.get('/v1/catalog/curricula', async (_request, reply) => {
    if (!db) return reply.status(200).send({ data: [] });

    try {
      const rows = await db
        .select({
          id: curriculumVersions.id,
          curriculumId: curricula.id,
          label: curricula.title,
          version: curriculumVersions.version,
        })
        .from(curricula)
        .innerJoin(
          curriculumVersions,
          and(
            eq(curriculumVersions.curriculumId, curricula.id),
            eq(curriculumVersions.version, curricula.publishedVersion),
          ),
        )
        .where(eq(curricula.active, true));

      const data = [
        ...FALLBACK_CURRICULA,
        ...rows
          .filter((row) => row.id !== FALLBACK_CURRICULA[0]?.id)
          .map((row) => ({ ...row, curriculumVersionId: row.id, status: 'active' as const })),
      ];
      return reply.status(200).send({ data });
    } catch {
      return reply.status(200).send({ data: FALLBACK_CURRICULA });
    }
  });

  const optionalAuth = auth
    ? async (request: FastifyRequest, reply: FastifyReply) => {
        if (request.headers.authorization) await auth(request, reply);
      }
    : async () => {};

  app.get('/v1/catalog/grades', { preHandler: optionalAuth }, async (request, reply) => {
    return reply.status(200).send({ data: await listGradesFor(db, request) });
  });

  app.get('/v1/catalog/phases', async (request, reply) => {
    const { gradeId } = request.query as { gradeId?: string };
    const data = gradeId
      ? OFFICIAL_PHASES.filter((phase) => phase.gradeIds.includes(gradeId))
      : OFFICIAL_PHASES;
    return reply.status(200).send({ data });
  });

  app.get('/v1/catalog/subjects', { preHandler: optionalAuth }, async (request, reply) => {
    const q = request.query as { gradeId?: string; curriculumVersionId?: string };
    const requestId = getRequestId(request);

    if (!q.gradeId) {
      return validationError(reply, 'Query gradeId wajib diisi.', requestId);
    }

    return reply.status(200).send({ data: await listSubjectsFor(db, q.gradeId, request) });
  });

  app.get('/v1/catalog/materials', { preHandler: optionalAuth }, async (request, reply) => {
    const q = request.query as {
      gradeId?: string;
      subjectId?: string;
      curriculumVersionId?: string;
    };
    const requestId = getRequestId(request);

    if (!q.gradeId || !q.subjectId || !q.curriculumVersionId) {
      return validationError(
        reply,
        'Query gradeId, subjectId, dan curriculumVersionId wajib diisi.',
        requestId,
      );
    }

    const tenantId = request.jwtUser?.workspaceId;
    if (db && tenantId) {
      try {
        const rows = await db
          .select({
            id: materials.id,
            label: materials.title,
            outcomeId: materials.outcomeId,
            publishedVersion: materials.publishedVersion,
            tenantId: materials.tenantId,
          })
          .from(materials)
          .where(
            and(
              eq(materials.tenantId, tenantId),
              eq(materials.gradeId, q.gradeId),
              eq(materials.subjectId, q.subjectId),
              isNotNull(materials.publishedVersion),
            ),
          );

        if (rows.length > 0) {
          return reply.status(200).send({
            data: rows
              .filter((r) => r.tenantId === tenantId)
              .map((r) => ({
                id: r.id,
                label: r.label,
                // Tenant materials are keyed by uuid, so the owning outcome
                // cannot be derived from the id shape the way the official
                // catalog ids allow — expose it explicitly instead.
                outcomeId: r.outcomeId ?? null,
                status: 'active' as const,
              })),
          });
        }
      } catch {
        // fall through
      }
    }

    return reply.status(200).send({
      data: listOfficialMaterials(q.gradeId, q.subjectId),
    });
  });

  // ── Admin CRUD endpoints (superadmin only) ────────────────────────────────

  // PATCH /v1/admin/catalog/grades/:id/status
  app.patch(
    '/v1/admin/catalog/grades/:id/status',
    { preHandler: adminGuard },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { status?: unknown };
      const requestId = getRequestId(request);
      const actor = request.jwtUser;

      if (!isValidStatus(body.status)) {
        return validationError(
          reply,
          `status harus salah satu dari: ${VALID_STATUSES.join(', ')}`,
          requestId,
        );
      }
      const status = body.status;

      // Update in-memory fallback
      const fallbackItem = FALLBACK_GRADES.find((g) => g.id === id);
      if (fallbackItem) fallbackItem.status = status;

      // Update DB jika tersedia (best-effort)
      if (db) {
        const pool = getPool(db);
        if (pool) {
          try {
            await pool.query(`UPDATE grades SET updated_at = now() WHERE id = $1`, [id]);
          } catch {
            /* best-effort */
          }
        }
      }

      await auditLog(db, actor?.userId ?? 'unknown', 'catalog.grade.status', 'grade', id, { status });

      return reply.status(200).send({ data: { id, status } });
    },
  );

  // PATCH /v1/admin/catalog/subjects/:id/status
  app.patch(
    '/v1/admin/catalog/subjects/:id/status',
    { preHandler: adminGuard },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { status?: unknown };
      const requestId = getRequestId(request);
      const actor = request.jwtUser;

      if (!isValidStatus(body.status)) {
        return validationError(
          reply,
          `status harus salah satu dari: ${VALID_STATUSES.join(', ')}`,
          requestId,
        );
      }
      const status = body.status;

      // Update in-memory fallback
      const fallbackItem = FALLBACK_SUBJECTS.find((s) => s.id === id);
      if (fallbackItem) fallbackItem.status = status;

      // Update DB jika tersedia (best-effort)
      if (db) {
        const pool = getPool(db);
        if (pool) {
          try {
            await pool.query(`UPDATE subjects SET updated_at = now() WHERE id = $1`, [id]);
          } catch {
            /* best-effort */
          }
        }
      }

      await auditLog(db, actor?.userId ?? 'unknown', 'catalog.subject.status', 'subject', id, {
        status,
      });

      return reply.status(200).send({ data: { id, status } });
    },
  );

  // POST /v1/admin/catalog/grades
  app.post('/v1/admin/catalog/grades', { preHandler: adminGuard }, async (request, reply) => {
    const body = request.body as { label?: unknown; status?: unknown };
    const requestId = getRequestId(request);
    const actor = request.jwtUser;

    if (typeof body.label !== 'string' || !body.label.trim()) {
      return validationError(reply, 'label wajib diisi (string).', requestId);
    }

    const label = body.label.trim();
    const status: CatalogStatus = body.status === 'archived' ? 'archived' : 'active';
    const id = `grade-${labelToSlug(label)}-${randomUUID().slice(0, 8)}`;

    const newItem: CatalogGradeOption = {
      id,
      label,
      status,
      jenjang: 'sd', // default; admin can update later
    };
    FALLBACK_GRADES.push(newItem);

    // Insert ke DB jika tersedia (best-effort, pakai raw SQL karena
    // kolom status tidak ada di schema Drizzle — disimpan sebagai metadata)
    if (db) {
      const pool = getPool(db);
      if (pool) {
        try {
          await pool.query(
            `INSERT INTO grades (id, curriculum_id, tenant_id, code, label, ordering)
               VALUES ($1, '00000000-0000-0000-0000-000000000000',
                       '00000000-0000-0000-0000-000000000000', $2, $3, 999)
               ON CONFLICT DO NOTHING`,
            [randomUUID(), id, label],
          );
        } catch {
          /* best-effort */
        }
      }
    }

    await auditLog(db, actor?.userId ?? 'unknown', 'catalog.grade.create', 'grade', id, {
      label,
      status,
    });

    return reply.status(201).send({ data: newItem });
  });

  // POST /v1/admin/catalog/subjects
  app.post('/v1/admin/catalog/subjects', { preHandler: adminGuard }, async (request, reply) => {
    const body = request.body as { label?: unknown; status?: unknown };
    const requestId = getRequestId(request);
    const actor = request.jwtUser;

    if (typeof body.label !== 'string' || !body.label.trim()) {
      return validationError(reply, 'label wajib diisi (string).', requestId);
    }

    const label = body.label.trim();
    const status: CatalogStatus = body.status === 'archived' ? 'archived' : 'active';
    const id = `subject-${labelToSlug(label)}-${randomUUID().slice(0, 8)}`;

    const newItem: CatalogSubjectOption = {
      id,
      label,
      status,
      jenjangList: ['sd', 'smp', 'sma', 'smk'], // default: lintas jenjang
    };
    FALLBACK_SUBJECTS.push(newItem);

    await auditLog(db, actor?.userId ?? 'unknown', 'catalog.subject.create', 'subject', id, {
      label,
      status,
    });

    return reply.status(201).send({ data: newItem });
  });

  // ── Admin read endpoints (superadmin only) ────────────────────────────────
  //
  // BUG-11/12: `/ops/catalog` and its "Tambah Materi" form are driven from the
  // superadmin console, so the same catalog the public routes serve must also be
  // reachable under `/v1/admin/catalog/*`. These previously fell through to the
  // not-found handler ("Module admin belum di-register"), which is what the
  // audit saw as 404.

  // GET /v1/admin/catalog/grades
  app.get('/v1/admin/catalog/grades', { preHandler: adminGuard }, async (request, reply) => {
    return reply.status(200).send({ data: await listGradesFor(db, request) });
  });

  // GET /v1/admin/catalog/subjects?gradeId=…
  app.get('/v1/admin/catalog/subjects', { preHandler: adminGuard }, async (request, reply) => {
    const gradeId = String((request.query as { gradeId?: string }).gradeId ?? '');
    const requestId = getRequestId(request);
    if (!gradeId) return validationError(reply, 'Query gradeId wajib diisi.', requestId);
    return reply.status(200).send({ data: await listSubjectsFor(db, gradeId, request) });
  });

  // GET /v1/admin/catalog/materials?gradeId=…&subjectId=…&curriculumVersionId=…
  //
  // Unlike the public route this also returns unpublished drafts, so a material
  // saved without "Publikasikan sekarang" is still visible to the admin who
  // created it.
  app.get('/v1/admin/catalog/materials', { preHandler: adminGuard }, async (request, reply) => {
    const q = request.query as {
      gradeId?: string;
      subjectId?: string;
      curriculumVersionId?: string;
    };
    const requestId = getRequestId(request);
    if (!q.gradeId || !q.subjectId || !q.curriculumVersionId) {
      return validationError(
        reply,
        'Query gradeId, subjectId, dan curriculumVersionId wajib diisi.',
        requestId,
      );
    }
    const tenantId = request.jwtUser?.workspaceId ?? null;
    if (db && tenantId && isUuid(q.subjectId)) {
      try {
        const rows = await db
          .select({
            id: materials.id,
            label: materials.title,
            outcomeId: materials.outcomeId,
            publishedVersion: materials.publishedVersion,
            tenantId: materials.tenantId,
          })
          .from(materials)
          .where(
            and(
              eq(materials.tenantId, tenantId),
              eq(materials.gradeId, q.gradeId),
              eq(materials.subjectId, q.subjectId),
            ),
          );
        return reply.status(200).send({
          data: rows.map((r) => ({
            id: r.id,
            label: r.label,
            outcomeId: r.outcomeId ?? null,
            status: r.publishedVersion ? ('active' as const) : ('draft' as const),
          })),
        });
      } catch {
        // fall through to the official catalog
      }
    }
    return reply.status(200).send({ data: listOfficialMaterials(q.gradeId, q.subjectId) });
  });

  app.get('/v1/admin/catalog/outcomes', { preHandler: adminGuard }, async (request, reply) => {
    const subjectId = String((request.query as { subjectId?: string }).subjectId ?? '');
    const requestId = getRequestId(request);
    if (!subjectId) return validationError(reply, 'subjectId wajib diisi.', requestId);
    const pool = db ? getPool(db) : undefined;
    if (!pool) {
      return reply.status(503).send({
        error: {
          code: 'CATALOG_UNAVAILABLE',
          message: 'Penyimpanan katalog belum tersedia.',
          requestId,
        },
      });
    }
    return reply
      .status(200)
      .send({ data: await listOutcomeOptions(pool, subjectId, request.jwtUser?.workspaceId ?? null) });
  });

  // POST /v1/admin/catalog/materials — trusted parent linkage is derived from outcome.
  app.post('/v1/admin/catalog/materials', { preHandler: adminGuard }, async (request, reply) => {
    const body = request.body as {
      outcomeId?: unknown;
      code?: unknown;
      kind?: unknown;
      title?: unknown;
      sourceRights?: unknown;
      publish?: unknown;
    };
    const requestId = getRequestId(request);
    const actor = request.jwtUser;
    if (
      typeof body.outcomeId !== 'string' || !body.outcomeId ||
      typeof body.code !== 'string' || !body.code.trim() ||
      typeof body.title !== 'string' || !body.title.trim() ||
      typeof body.kind !== 'string' || !(MATERIAL_KINDS as readonly string[]).includes(body.kind) ||
      typeof body.sourceRights !== 'string' || !(SOURCE_RIGHTS_VALUES as readonly string[]).includes(body.sourceRights)
    ) {
      return validationError(reply, 'outcomeId, kode, jenis, judul, dan hak sumber yang valid wajib diisi.', requestId);
    }
    const pool = db ? getPool(db) : undefined;
    if (!pool) return reply.status(503).send({ error: { code: 'CATALOG_UNAVAILABLE', message: 'Penyimpanan katalog belum tersedia.', requestId } });
    const publish = body.publish === true;
    if (publish && !(APPROVED_SOURCE_RIGHTS as readonly string[]).includes(body.sourceRights)) {
      return validationError(reply, 'Hak sumber harus internal, CC BY, atau CC BY-SA sebelum materi dipublikasikan.', requestId);
    }

    // The outcome id is either a tenant outcome uuid or the derived official CP
    // id (`<officialSubjectId>-cp`). Official ids have no DB row yet, so the
    // parent chain is materialized on demand — otherwise the insert would have
    // no FK parent and the caller would be stuck.
    let p: {
      id: string;
      subject_id: string;
      phase_id: string;
      grade_id: string;
      curriculum_id: string;
      tenant_id: string;
    };
    if (isUuid(body.outcomeId)) {
      const parent = await pool.query(
        `SELECT id, subject_id, phase_id, grade_id, curriculum_id, tenant_id FROM outcomes WHERE id = $1 LIMIT 1`,
        [body.outcomeId],
      );
      if (!parent.rows[0]) return notFoundError(reply, 'CP/Outcome tidak ditemukan.', requestId);
      p = parent.rows[0] as typeof p;
    } else {
      const officialSubjectId = officialSubjectIdFromOutcomeId(body.outcomeId);
      if (!officialSubjectId) return notFoundError(reply, 'CP/Outcome tidak ditemukan.', requestId);
      try {
        const chain = await materializeOfficialOutcome(
          pool,
          officialSubjectId,
          request.jwtUser?.workspaceId ?? null,
        );
        p = {
          id: chain.outcomeId,
          subject_id: chain.subjectId,
          phase_id: chain.phaseId,
          grade_id: chain.gradeId,
          curriculum_id: chain.curriculumId,
          tenant_id: chain.tenantId,
        };
      } catch (err) {
        if (err instanceof OfficialOutcomeNotFound) {
          return notFoundError(reply, 'CP/Outcome tidak ditemukan.', requestId);
        }
        throw err;
      }
    }

    try {
      // One transaction so a failed publish (material_versions insert or the
      // published_version update) cannot leave a half-created material behind.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await client.query(
          `INSERT INTO materials (outcome_id, subject_id, phase_id, grade_id, curriculum_id, tenant_id, code, kind, title, source_rights, ordering)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9,$10,0)
           RETURNING id, title, published_version`,
          [p.id, p.subject_id, p.phase_id, p.grade_id, p.curriculum_id, p.tenant_id, body.code.trim(), body.kind, body.title.trim(), body.sourceRights],
        );
        const item = inserted.rows[0] as { id: string; title: string };
        if (publish) {
          // jsonb_build_object takes variadic `any` arguments, so every
          // parameter needs an explicit cast or Postgres cannot infer its type
          // ("could not determine data type of parameter $2").
          await client.query(
            `INSERT INTO material_versions (material_id, version, payload, published_by)
             VALUES ($1::uuid, 1,
                     jsonb_build_object(
                       'outcome_id', $2::text, 'subject_id', $3::text, 'phase_id', $4::text,
                       'grade_id', $5::text, 'curriculum_id', $6::text, 'code', $7::text,
                       'kind', $8::text, 'title', $9::text, 'source_rights', $10::text, 'ordering', 0
                     ),
                     $11::text)`,
            [item.id, p.id, p.subject_id, p.phase_id, p.grade_id, p.curriculum_id, body.code.trim(), body.kind, item.title, body.sourceRights, actor?.userId ?? null],
          );
          await client.query(
            `UPDATE materials SET published_version = 1, current_version = 1 WHERE id = $1::uuid`,
            [item.id],
          );
        }
        await client.query('COMMIT');
        await auditLog(db, actor?.userId ?? 'unknown', 'catalog.material.create', 'material', item.id, { publish });
        return reply.status(201).send({ data: { id: item.id, title: item.title, published: publish } });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return validationError(reply, 'Kode materi sudah digunakan pada CP ini.', requestId);
      throw err;
    }
  });

  // DELETE /v1/admin/catalog/grades/:id  (soft delete → archived)
  app.delete('/v1/admin/catalog/grades/:id', { preHandler: adminGuard }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const requestId = getRequestId(request);
    const actor = request.jwtUser;

    const item = FALLBACK_GRADES.find((g) => g.id === id);
    if (!item) {
      return notFoundError(reply, `Grade '${id}' tidak ditemukan.`, requestId);
    }

    item.status = 'archived';

    await auditLog(db, actor?.userId ?? 'unknown', 'catalog.grade.delete', 'grade', id, {});

    return reply.status(200).send({ data: { id, archived: true } });
  });

  // DELETE /v1/admin/catalog/subjects/:id  (soft delete → archived)
  app.delete(
    '/v1/admin/catalog/subjects/:id',
    { preHandler: adminGuard },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const requestId = getRequestId(request);
      const actor = request.jwtUser;

      const item = FALLBACK_SUBJECTS.find((s) => s.id === id);
      if (!item) {
        return notFoundError(reply, `Subject '${id}' tidak ditemukan.`, requestId);
      }

      item.status = 'archived';

      await auditLog(db, actor?.userId ?? 'unknown', 'catalog.subject.delete', 'subject', id, {});

      return reply.status(200).send({ data: { id, archived: true } });
    },
  );
}
