/**
 * Catalog HTTP routes — OpenAPI: /v1/catalog/grades|subjects|materials
 *
 * Returns CatalogOption[]: { id, label, status }
 * Reads from curriculum tables when available; falls back to seed options.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, eq, isNotNull } from 'drizzle-orm';

import type { Database } from '../../../../infrastructure/database/db.js';
import {
  grades,
  subjects,
  materials,
} from '../../../curriculum/persistence/schema.js';

export interface CatalogOption {
  id: string;
  label: string;
  status: 'active' | 'archived' | 'unavailable';
}

export interface RegisterCatalogRoutesOptions {
  db?: Database;
}

const FALLBACK_GRADES: CatalogOption[] = [
  { id: 'grade-1', label: 'Kelas 1', status: 'active' },
  { id: 'grade-2', label: 'Kelas 2', status: 'active' },
  { id: 'grade-3', label: 'Kelas 3', status: 'active' },
  { id: 'grade-4', label: 'Kelas 4', status: 'active' },
  { id: 'grade-5', label: 'Kelas 5', status: 'active' },
  { id: 'grade-6', label: 'Kelas 6', status: 'active' },
  { id: 'grade-7', label: 'Kelas 7', status: 'active' },
  { id: 'grade-8', label: 'Kelas 8', status: 'active' },
  { id: 'grade-9', label: 'Kelas 9', status: 'active' },
  { id: 'grade-10', label: 'Kelas 10', status: 'active' },
  { id: 'grade-11', label: 'Kelas 11', status: 'active' },
  { id: 'grade-12', label: 'Kelas 12', status: 'active' },
];

const FALLBACK_SUBJECTS: CatalogOption[] = [
  { id: 'subject-matematika', label: 'Matematika', status: 'active' },
  { id: 'subject-bahasa-indonesia', label: 'Bahasa Indonesia', status: 'active' },
  { id: 'subject-ipa', label: 'IPA', status: 'active' },
  { id: 'subject-ips', label: 'IPS', status: 'active' },
  { id: 'subject-bahasa-inggris', label: 'Bahasa Inggris', status: 'active' },
];

const FALLBACK_MATERIALS: CatalogOption[] = [
  { id: 'material-bab-1', label: 'Bab 1 — Pengantar', status: 'active' },
  { id: 'material-bab-2', label: 'Bab 2 — Inti Materi', status: 'active' },
  { id: 'material-bab-3', label: 'Bab 3 — Latihan', status: 'active' },
];

function getRequestId(req: FastifyRequest): string {
  return req.requestId ?? 'req_unknown';
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

export async function registerCatalogRoutes(
  app: FastifyInstance,
  options: RegisterCatalogRoutesOptions = {},
): Promise<void> {
  const db = options.db;

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
              status: 'active' as const,
            })),
          });
        }
      } catch {
        // fall through
      }
    }

    // Fallback: return static subjects scoped by gradeId prefix
    return reply.status(200).send({
      data: FALLBACK_SUBJECTS.map((s) => ({
        ...s,
        id: `${q.gradeId}-${s.id}`,
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

    return reply.status(200).send({
      data: FALLBACK_MATERIALS.map((m) => ({
        ...m,
        id: `${q.subjectId}-${m.id}`,
      })),
    });
  });
}
