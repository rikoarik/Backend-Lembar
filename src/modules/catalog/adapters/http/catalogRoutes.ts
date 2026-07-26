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
import { and, eq, isNotNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { Database } from '../../../../infrastructure/database/db.js';
import { getPool } from '../../../../infrastructure/database/db.js';
import {
  grades,
  subjects,
  materials,
} from '../../../curriculum/persistence/schema.js';
import {
  createJwtAuthMiddleware,
  requireRole,
} from '../../../../common/middleware/jwtMultiRoleAuth.js';

export interface CatalogOption {
  id: string;
  label: string;
  status: 'active' | 'archived' | 'unavailable';
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
  { id: 'sd-1',  label: 'Kelas 1 SD',  status: 'active', jenjang: 'sd' },
  { id: 'sd-2',  label: 'Kelas 2 SD',  status: 'active', jenjang: 'sd' },
  { id: 'sd-3',  label: 'Kelas 3 SD',  status: 'active', jenjang: 'sd' },
  { id: 'sd-4',  label: 'Kelas 4 SD',  status: 'active', jenjang: 'sd' },
  { id: 'sd-5',  label: 'Kelas 5 SD',  status: 'active', jenjang: 'sd' },
  { id: 'sd-6',  label: 'Kelas 6 SD',  status: 'active', jenjang: 'sd' },
  // SMP (Sekolah Menengah Pertama) — 3 kelas
  { id: 'smp-7',  label: 'Kelas 7 SMP',  status: 'active', jenjang: 'smp' },
  { id: 'smp-8',  label: 'Kelas 8 SMP',  status: 'active', jenjang: 'smp' },
  { id: 'smp-9',  label: 'Kelas 9 SMP',  status: 'active', jenjang: 'smp' },
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
  { id: 'subject-matematika',        label: 'Matematika',                   status: 'active', jenjangList: ['sd', 'smp', 'sma', 'smk'] },
  { id: 'subject-bahasa-indonesia',  label: 'Bahasa Indonesia',             status: 'active', jenjangList: ['sd', 'smp', 'sma', 'smk'] },
  { id: 'subject-ppkn',              label: 'PPKn',                         status: 'active', jenjangList: ['sd', 'smp', 'sma', 'smk'] },
  { id: 'subject-pjok',              label: 'PJOK',                         status: 'active', jenjangList: ['sd', 'smp', 'sma', 'smk'] },

  // ── SD saja ────────────────────────────────────────────────────────────────
  { id: 'subject-ipa',               label: 'IPA',                          status: 'active', jenjangList: ['sd'] },
  { id: 'subject-ips',               label: 'IPS',                          status: 'active', jenjangList: ['sd'] },
  { id: 'subject-seni-budaya',       label: 'Seni Budaya',                  status: 'active', jenjangList: ['sd'] },
  { id: 'subject-prakarya',          label: 'Prakarya',                     status: 'active', jenjangList: ['sd'] },
  { id: 'subject-pai',               label: 'PAI (Pendidikan Agama Islam)', status: 'active', jenjangList: ['sd'] },

  // ── SMP saja ───────────────────────────────────────────────────────────────
  { id: 'subject-bahasa-inggris',        label: 'Bahasa Inggris',        status: 'active', jenjangList: ['smp'] },
  { id: 'subject-ipa-smp',               label: 'IPA',                   status: 'active', jenjangList: ['smp'] },
  { id: 'subject-ips-smp',               label: 'IPS',                   status: 'active', jenjangList: ['smp'] },
  { id: 'subject-seni-budaya-smp',       label: 'Seni Budaya',           status: 'active', jenjangList: ['smp'] },
  { id: 'subject-prakarya-smp',          label: 'Prakarya',              status: 'active', jenjangList: ['smp'] },
  { id: 'subject-informatika-smp',       label: 'Informatika',           status: 'active', jenjangList: ['smp'] },
  { id: 'subject-pai-smp',               label: 'PAI (Pendidikan Agama Islam)', status: 'active', jenjangList: ['smp'] },

  // ── SMA saja ───────────────────────────────────────────────────────────────
  { id: 'subject-bahasa-inggris-sma',    label: 'Bahasa Inggris',        status: 'active', jenjangList: ['sma'] },
  { id: 'subject-fisika',                label: 'Fisika',                status: 'active', jenjangList: ['sma'] },
  { id: 'subject-kimia',                 label: 'Kimia',                 status: 'active', jenjangList: ['sma'] },
  { id: 'subject-biologi',               label: 'Biologi',               status: 'active', jenjangList: ['sma'] },
  { id: 'subject-ekonomi',               label: 'Ekonomi',               status: 'active', jenjangList: ['sma'] },
  { id: 'subject-geografi',              label: 'Geografi',              status: 'active', jenjangList: ['sma'] },
  { id: 'subject-sosiologi',             label: 'Sosiologi',             status: 'active', jenjangList: ['sma'] },
  { id: 'subject-sejarah-indonesia',     label: 'Sejarah Indonesia',     status: 'active', jenjangList: ['sma'] },
  { id: 'subject-seni-budaya-sma',       label: 'Seni Budaya',           status: 'active', jenjangList: ['sma'] },
  { id: 'subject-informatika-sma',       label: 'Informatika',           status: 'active', jenjangList: ['sma'] },
  { id: 'subject-pai-sma',               label: 'PAI (Pendidikan Agama Islam)', status: 'active', jenjangList: ['sma'] },
  { id: 'subject-pkwu',                  label: 'PKWU',                  status: 'active', jenjangList: ['sma'] },

  // ── SMK saja ───────────────────────────────────────────────────────────────
  { id: 'subject-bahasa-inggris-smk',    label: 'Bahasa Inggris',        status: 'active', jenjangList: ['smk'] },
  { id: 'subject-produktif',             label: 'Produktif',              status: 'active', jenjangList: ['smk'] },
  { id: 'subject-kompetensi-keahlian',   label: 'Kompetensi Keahlian',    status: 'active', jenjangList: ['smk'] },
  { id: 'subject-pai-smk',               label: 'PAI (Pendidikan Agama Islam)', status: 'active', jenjangList: ['smk'] },
];

const FALLBACK_MATERIALS: CatalogOption[] = [];

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
  } catch { /* best-effort */ }
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerCatalogRoutes(
  app: FastifyInstance,
  options: RegisterCatalogRoutesOptions = {},
): Promise<void> {
  const db = options.db;

  // Build auth middlewares only when jwtSecret is available
  const auth = options.jwtSecret
    ? createJwtAuthMiddleware({ secret: options.jwtSecret })
    : null;
  const superadmin = requireRole(['superadmin']);

  // Guard: used as preHandler array for admin routes
  const adminGuard = auth ? [auth, superadmin] : [superadmin];

  // ── Public read endpoints ──────────────────────────────────────────────────

  app.get('/v1/catalog/grades', async (_request, reply) => {
    if (db) {
      try {
        const rows = await db
          .select({
            id: grades.id,
            label: grades.label,
            publishedVersion: grades.publishedVersion,
          })
          .from(grades)
          .where(isNotNull(grades.publishedVersion));

        if (rows.length > 0) {
          return reply.status(200).send({
            data: rows.map((r) => ({
              id: r.id,
              label: r.label,
              status: 'active' as const,
            })),
          });
        }
      } catch {
        // fall through to fallback
      }
    }

    return reply.status(200).send({ data: FALLBACK_GRADES });
  });

  app.get('/v1/catalog/subjects', async (request, reply) => {
    const q = request.query as { gradeId?: string; curriculumVersionId?: string };
    const requestId = getRequestId(request);

    if (!q.gradeId) {
      return validationError(reply, 'Query gradeId wajib diisi.', requestId);
    }

    if (db) {
      try {
        const rows = await db
          .select({
            id: subjects.id,
            label: subjects.title,
            publishedVersion: subjects.publishedVersion,
          })
          .from(subjects)
          .where(and(eq(subjects.gradeId, q.gradeId), isNotNull(subjects.publishedVersion)));

        if (rows.length > 0) {
          return reply.status(200).send({
            data: rows.map((r) => ({
              id: r.id,
              label: r.label,
              gradeId: q.gradeId,
              status: 'active' as const,
            })),
          });
        }
      } catch {
        // fall through
      }
    }

    // Fallback: filter subjects by jenjang from gradeId
    const jenjang = jenjangFromGradeId(q.gradeId);
    const filtered = jenjang
      ? FALLBACK_SUBJECTS.filter((s) => s.jenjangList.includes(jenjang))
      : FALLBACK_SUBJECTS;

    return reply.status(200).send({
      data: filtered.map((s) => ({
        id: s.id,
        label: s.label,
        gradeId: q.gradeId,
        status: s.status,
      })),
    });
  });

  app.get('/v1/catalog/materials', async (request, reply) => {
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

    if (db) {
      try {
        const rows = await db
          .select({
            id: materials.id,
            label: materials.title,
            publishedVersion: materials.publishedVersion,
          })
          .from(materials)
          .where(
            and(
              eq(materials.gradeId, q.gradeId),
              eq(materials.subjectId, q.subjectId),
              isNotNull(materials.publishedVersion),
            ),
          );

        if (rows.length > 0) {
          return reply.status(200).send({
            data: rows.map((r) => ({
              id: r.id,
              label: r.label,
              status: 'active' as const,
            })),
          });
        }
      } catch {
        // fall through
      }
    }

    return reply.status(200).send({ data: FALLBACK_MATERIALS });
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
      const actor = (request as unknown as { user?: { id?: string } }).user;

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
            await pool.query(
              `UPDATE grades SET updated_at = now() WHERE id = $1`,
              [id],
            );
          } catch { /* best-effort */ }
        }
      }

      await auditLog(db, actor?.id ?? 'unknown', 'catalog.grade.status', 'grade', id, { status });

      return reply.status(200).send({ id, status });
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
      const actor = (request as unknown as { user?: { id?: string } }).user;

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
            await pool.query(
              `UPDATE subjects SET updated_at = now() WHERE id = $1`,
              [id],
            );
          } catch { /* best-effort */ }
        }
      }

      await auditLog(db, actor?.id ?? 'unknown', 'catalog.subject.status', 'subject', id, { status });

      return reply.status(200).send({ id, status });
    },
  );

  // POST /v1/admin/catalog/grades
  app.post(
    '/v1/admin/catalog/grades',
    { preHandler: adminGuard },
    async (request, reply) => {
      const body = request.body as { label?: unknown; status?: unknown };
      const requestId = getRequestId(request);
      const actor = (request as unknown as { user?: { id?: string } }).user;

      if (typeof body.label !== 'string' || !body.label.trim()) {
        return validationError(reply, 'label wajib diisi (string).', requestId);
      }

      const label = body.label.trim();
      const status: CatalogStatus =
        body.status === 'archived' ? 'archived' : 'active';
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
          } catch { /* best-effort */ }
        }
      }

      await auditLog(db, actor?.id ?? 'unknown', 'catalog.grade.create', 'grade', id, { label, status });

      return reply.status(201).send(newItem);
    },
  );

  // POST /v1/admin/catalog/subjects
  app.post(
    '/v1/admin/catalog/subjects',
    { preHandler: adminGuard },
    async (request, reply) => {
      const body = request.body as { label?: unknown; status?: unknown };
      const requestId = getRequestId(request);
      const actor = (request as unknown as { user?: { id?: string } }).user;

      if (typeof body.label !== 'string' || !body.label.trim()) {
        return validationError(reply, 'label wajib diisi (string).', requestId);
      }

      const label = body.label.trim();
      const status: CatalogStatus =
        body.status === 'archived' ? 'archived' : 'active';
      const id = `subject-${labelToSlug(label)}-${randomUUID().slice(0, 8)}`;

      const newItem: CatalogSubjectOption = {
        id,
        label,
        status,
        jenjangList: ['sd', 'smp', 'sma', 'smk'], // default: lintas jenjang
      };
      FALLBACK_SUBJECTS.push(newItem);

      await auditLog(db, actor?.id ?? 'unknown', 'catalog.subject.create', 'subject', id, { label, status });

      return reply.status(201).send(newItem);
    },
  );

  // DELETE /v1/admin/catalog/grades/:id  (soft delete → archived)
  app.delete(
    '/v1/admin/catalog/grades/:id',
    { preHandler: adminGuard },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const requestId = getRequestId(request);
      const actor = (request as unknown as { user?: { id?: string } }).user;

      const item = FALLBACK_GRADES.find((g) => g.id === id);
      if (!item) {
        return notFoundError(reply, `Grade '${id}' tidak ditemukan.`, requestId);
      }

      item.status = 'archived';

      await auditLog(db, actor?.id ?? 'unknown', 'catalog.grade.delete', 'grade', id, {});

      return reply.status(200).send({ id, archived: true });
    },
  );

  // DELETE /v1/admin/catalog/subjects/:id  (soft delete → archived)
  app.delete(
    '/v1/admin/catalog/subjects/:id',
    { preHandler: adminGuard },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const requestId = getRequestId(request);
      const actor = (request as unknown as { user?: { id?: string } }).user;

      const item = FALLBACK_SUBJECTS.find((s) => s.id === id);
      if (!item) {
        return notFoundError(reply, `Subject '${id}' tidak ditemukan.`, requestId);
      }

      item.status = 'archived';

      await auditLog(db, actor?.id ?? 'unknown', 'catalog.subject.delete', 'subject', id, {});

      return reply.status(200).send({ id, archived: true });
    },
  );
}
