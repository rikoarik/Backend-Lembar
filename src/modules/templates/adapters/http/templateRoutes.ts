import type { FastifyInstance } from 'fastify';
import { createJwtAuthMiddleware } from '../../../../common/middleware/jwtMultiRoleAuth.js';
import { throwApiError } from '../../../../common/errors/apiError.js';
import { getPool, type Database } from '../../../../infrastructure/database/db.js';

const sourceModes = new Set(['katalog', 'pdf', 'katalog+pdf']);
const assessmentTypes = new Set(['practice', 'daily', 'midterm', 'final', 'tka', 'promotion']);
const difficulties = new Set(['easy', 'medium', 'hard', 'mixed']);
const reviewModes = new Set(['quick', 'detail']);

function cleanConfig(raw: unknown) {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== 'object') throwApiError('validation_error', 'Konfigurasi template tidak valid');
  const sourceMode = String(value.sourceMode ?? 'katalog');
  const assessmentType = String(value.assessmentType ?? 'practice');
  const difficulty = String(value.difficulty ?? 'medium');
  const reviewMode = String(value.reviewMode ?? 'quick');
  const questionCount = Number(value.questionCount);
  if (!sourceModes.has(sourceMode) || !assessmentTypes.has(assessmentType) || !difficulties.has(difficulty) || !reviewModes.has(reviewMode) || !Number.isInteger(questionCount) || questionCount < 1 || questionCount > 200) {
    throwApiError('validation_error', 'Konfigurasi template tidak valid');
  }
  const text = (key: string, max: number) => {
    const result = typeof value[key] === 'string' ? value[key].trim() : '';
    if (result.length > max) throwApiError('validation_error', `Isian ${key} terlalu panjang`);
    return result;
  };
  const materialIds = Array.isArray(value.materialIds)
    ? value.materialIds.filter((id): id is string => typeof id === 'string').slice(0, 100)
    : [];
  const questionTypeCounts = value.questionTypeCounts && typeof value.questionTypeCounts === 'object' && !Array.isArray(value.questionTypeCounts)
    ? Object.fromEntries(Object.entries(value.questionTypeCounts as Record<string, unknown>)
      .filter(([key, count]) => ['multiple_choice', 'essay', 'true_false', 'matching'].includes(key) && Number.isInteger(Number(count)) && Number(count) >= 0 && Number(count) <= questionCount))
    : {};
  const integer = (key: string, min: number, max: number, fallback: number) => {
    const parsed = Number(value[key] ?? fallback);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throwApiError('validation_error', `Isian ${key} tidak valid`);
    return parsed;
  };
  const enumValue = (key: string, allowed: readonly string[], fallback: string) => {
    const parsed = String(value[key] ?? fallback);
    if (!allowed.includes(parsed)) throwApiError('validation_error', `Isian ${key} tidak valid`);
    return parsed;
  };
  return {
    sourceMode, curriculumVersionId: text('curriculumVersionId', 100), gradeId: text('gradeId', 100),
    subjectId: text('subjectId', 100), materialIds, sourceId: '', assessmentType, difficulty,
    questionCount, questionTypeCounts, reviewMode, teacherFocus: text('teacherFocus', 500), exampleQuestion: text('exampleQuestion', 2000),
    academicYear: text('academicYear', 30), durationMinutes: integer('durationMinutes', 0, 480, 0),
    imageMode: enumValue('imageMode', ['none', 'auto'], 'none'), imageMaxCount: integer('imageMaxCount', 0, 10, 0),
    imageStyle: text('imageStyle', 100), imageProvider: text('imageProvider', 100),
  };
}

export async function registerTemplateRoutes(app: FastifyInstance, options: { db: Database; jwtSecret: string }) {
  const pool = getPool(options.db);
  if (!pool) return;
  const auth = createJwtAuthMiddleware({ secret: options.jwtSecret, db: options.db });

  app.get('/v1/templates', { preHandler: [auth] }, async (request) => {
    const workspaceId = request.jwtUser?.workspaceId;
    if (!workspaceId) throwApiError('forbidden', 'Workspace aktif diperlukan');
    const result = await pool.query(
      `SELECT id,name,config,created_at AS "createdAt",updated_at AS "updatedAt"
       FROM generation_templates WHERE workspace_id=$1 ORDER BY updated_at DESC`, [workspaceId]);
    return { data: result.rows };
  });

  app.post('/v1/templates', { preHandler: [auth] }, async (request, reply) => {
    const user = request.jwtUser;
    if (!user?.workspaceId || !user.userId) throwApiError('forbidden', 'Workspace aktif diperlukan');
    const body = request.body as { name?: unknown; config?: unknown };
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) throwApiError('validation_error', 'Nama template wajib diisi');
    const config = cleanConfig(body.config);
    try {
      const result = await pool.query(
        `INSERT INTO generation_templates (workspace_id,owner_user_id,name,config) VALUES ($1,$2,$3,$4)
         RETURNING id,name,config,created_at AS "createdAt",updated_at AS "updatedAt"`,
        [user.workspaceId, user.userId, name, JSON.stringify(config)]);
      return reply.status(201).send({ data: result.rows[0] });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throwApiError('conflict', 'Nama template sudah digunakan');
      throw error;
    }
  });

  app.delete('/v1/templates/:templateId', { preHandler: [auth] }, async (request, reply) => {
    const workspaceId = request.jwtUser?.workspaceId;
    if (!workspaceId) throwApiError('forbidden', 'Workspace aktif diperlukan');
    const { templateId } = request.params as { templateId: string };
    const result = await pool.query('DELETE FROM generation_templates WHERE id=$1 AND workspace_id=$2 RETURNING id', [templateId, workspaceId]);
    if (!result.rows[0]) throwApiError('not_found', 'Template tidak ditemukan');
    return reply.status(204).send();
  });
}
