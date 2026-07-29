import type { FastifyInstance } from 'fastify';
import { createJwtAuthMiddleware } from '../../../../common/middleware/jwtMultiRoleAuth.js';
import { throwApiError } from '../../../../common/errors/apiError.js';
import { getPool, type Database } from '../../../../infrastructure/database/db.js';

export async function registerClassRoutes(app: FastifyInstance, options: { db: Database; jwtSecret: string }) {
  const pool = getPool(options.db);
  if (!pool) return;
  const auth = createJwtAuthMiddleware({ secret: options.jwtSecret, db: options.db });

  app.get('/v1/classes', { preHandler: [auth] }, async (request) => {
    const workspaceId = request.jwtUser?.workspaceId;
    if (!workspaceId) throwApiError('forbidden', 'Workspace aktif diperlukan');
    const result = await pool.query(
      `SELECT c.id, c.name, c.grade_label AS "gradeLabel", c.school_year AS "schoolYear",
              c.created_at AS "createdAt", COUNT(s.id)::int AS "studentCount"
       FROM teacher_classes c LEFT JOIN class_students s ON s.class_id = c.id
       WHERE c.workspace_id = $1 GROUP BY c.id ORDER BY c.created_at DESC`,
      [workspaceId],
    );
    return { data: result.rows };
  });

  app.post('/v1/classes', { preHandler: [auth] }, async (request, reply) => {
    const user = request.jwtUser;
    if (!user?.workspaceId || !user.userId) throwApiError('forbidden', 'Workspace aktif diperlukan');
    const body = request.body as { name?: unknown; gradeLabel?: unknown; schoolYear?: unknown };
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const gradeLabel = typeof body?.gradeLabel === 'string' ? body.gradeLabel.trim() : '';
    const schoolYear = typeof body?.schoolYear === 'string' ? body.schoolYear.trim() : '';
    if (!name || name.length > 80 || gradeLabel.length > 80 || schoolYear.length > 20) {
      throwApiError('validation_error', 'Nama kelas wajib diisi dan panjang isian harus valid');
    }
    try {
      const result = await pool.query(
        `INSERT INTO teacher_classes (workspace_id, owner_user_id, name, grade_label, school_year)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id,name,grade_label AS "gradeLabel",school_year AS "schoolYear",created_at AS "createdAt"`,
        [user.workspaceId, user.userId, name, gradeLabel, schoolYear],
      );
      return reply.status(201).send({ data: { ...result.rows[0], studentCount: 0 } });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throwApiError('conflict', 'Nama kelas sudah digunakan');
      throw error;
    }
  });

  app.get('/v1/classes/:classId/students', { preHandler: [auth] }, async (request) => {
    const workspaceId = request.jwtUser?.workspaceId;
    if (!workspaceId) throwApiError('forbidden', 'Workspace aktif diperlukan');
    const { classId } = request.params as { classId: string };
    const result = await pool.query(
      `SELECT s.id,s.name,s.student_number AS "studentNumber",s.created_at AS "createdAt"
       FROM class_students s JOIN teacher_classes c ON c.id=s.class_id
       WHERE s.class_id=$1 AND c.workspace_id=$2 ORDER BY s.name`,
      [classId, workspaceId],
    );
    return { data: result.rows };
  });

  app.post('/v1/classes/:classId/students', { preHandler: [auth] }, async (request, reply) => {
    const workspaceId = request.jwtUser?.workspaceId;
    if (!workspaceId) throwApiError('forbidden', 'Workspace aktif diperlukan');
    const { classId } = request.params as { classId: string };
    const body = request.body as { name?: unknown; studentNumber?: unknown };
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const studentNumber = typeof body?.studentNumber === 'string' ? body.studentNumber.trim() : '';
    if (!name || name.length > 120 || studentNumber.length > 50) throwApiError('validation_error', 'Nama siswa wajib diisi');
    const result = await pool.query(
      `INSERT INTO class_students (class_id,name,student_number)
       SELECT id,$2,$3 FROM teacher_classes WHERE id=$1 AND workspace_id=$4
       RETURNING id,name,student_number AS "studentNumber",created_at AS "createdAt"`,
      [classId, name, studentNumber, workspaceId],
    );
    if (!result.rows[0]) throwApiError('not_found', 'Kelas tidak ditemukan');
    return reply.status(201).send({ data: result.rows[0] });
  });

  app.delete('/v1/classes/:classId/students/:studentId', { preHandler: [auth] }, async (request, reply) => {
    const workspaceId = request.jwtUser?.workspaceId;
    if (!workspaceId) throwApiError('forbidden', 'Workspace aktif diperlukan');
    const { classId, studentId } = request.params as { classId: string; studentId: string };
    const result = await pool.query(
      `DELETE FROM class_students s USING teacher_classes c
       WHERE s.id=$1 AND s.class_id=$2 AND c.id=s.class_id AND c.workspace_id=$3 RETURNING s.id`,
      [studentId, classId, workspaceId],
    );
    if (!result.rows[0]) throwApiError('not_found', 'Siswa tidak ditemukan');
    return reply.status(204).send();
  });
}
