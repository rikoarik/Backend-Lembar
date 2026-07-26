/**
 * School Library routes — finalized assessments visible to all workspace members.
 *
 * GET /v1/school/library       — list finalized assessments (any school member)
 * GET /v1/school/library/:id   — detail: questions summary, blueprint, author
 *
 * Auth: JWT Bearer (any authenticated user with a workspaceId)
 * workspaceId is read from request.jwtUser.workspaceId
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getPool, type Database } from '../../../../infrastructure/database/db.js';
import {
  createJwtAuthMiddleware,
} from '../../../../common/middleware/jwtMultiRoleAuth.js';
import { throwApiError } from '../../../../common/errors/apiError.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? req.requestId ?? 'req_unknown';
}

export interface RegisterLibraryRoutesOptions {
  db: Database;
  jwtSecret: string;
}

export async function registerLibraryRoutes(
  app: FastifyInstance,
  options: RegisterLibraryRoutesOptions,
): Promise<void> {
  const { db, jwtSecret } = options;
  const auth = createJwtAuthMiddleware({ secret: jwtSecret });

  // ── GET /v1/school/library ────────────────────────────────────────────────
  app.get('/v1/school/library', { preHandler: [auth] }, async (request, reply) => {
    const requestId = getRequestId(request);
    const user = request.jwtUser!;

    if (!user.workspaceId) {
      throwApiError('forbidden', 'Akun tidak terhubung ke workspace sekolah');
    }
    const workspaceId = user.workspaceId!;

    const { q, page: pageStr, limit: limitStr } = request.query as {
      q?: string;
      page?: string;
      limit?: string;
    };

    const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(limitStr ?? '20', 10) || 20));
    const offset = (page - 1) * limit;

    const pool = getPool(db);
    if (!pool) {
      return reply.status(200).send({ data: [], meta: { total: 0, page, limit, pages: 0 } });
    }

    // Build optional search filter
    const searchClause = q
      ? `AND (a.title ILIKE $3)`
      : '';
    const searchParam = q ? `%${q}%` : null;

    const countParams: unknown[] = [workspaceId, 'finalized'];
    const rowParams: unknown[] = [workspaceId, 'finalized'];
    if (q) {
      countParams.push(searchParam);
      rowParams.push(searchParam);
    }
    rowParams.push(limit, offset);
    const limitIdx = rowParams.length - 1;   // $N for limit (last but one)
    const offsetIdx = rowParams.length;       // $N for offset (last)

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM assessments a
      WHERE a.workspace_id = $1
        AND a.status = $2
        ${searchClause}
    `;

    const rowsSql = `
      SELECT
        a.id,
        a.title,
        '' AS subject,
        '' AS grade,
        0 AS "questionCount",
        a.created_at           AS "createdAt",
        a.creator_user_id            AS "authorId",
        COALESCE(u.name, u.email, a.creator_user_id::text) AS "authorName"
      FROM assessments a
      LEFT JOIN jwt_users u ON u.id = a.creator_user_id
      WHERE a.workspace_id = $1
        AND a.status = $2
        ${searchClause}
      ORDER BY a.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const [countRes, rowsRes] = await Promise.all([
      pool.query<{ total: number }>(countSql, countParams),
      pool.query<{
        id: string;
        title: string;
        subject: string | null;
        grade: string | null;
        questionCount: number | null;
        createdAt: string;
        authorId: string | null;
        authorName: string | null;
      }>(rowsSql, rowParams),
    ]);

    const total = countRes.rows[0]?.total ?? 0;
    const pages = Math.ceil(total / limit);

    return reply.status(200).send({
      data: rowsRes.rows,
      meta: { total, page, limit, pages },
    });
  });

  // ── GET /v1/school/library/:id ────────────────────────────────────────────
  app.get('/v1/school/library/:id', { preHandler: [auth] }, async (request, reply) => {
    const requestId = getRequestId(request);
    const user = request.jwtUser!;

    if (!user.workspaceId) {
      throwApiError('forbidden', 'Akun tidak terhubung ke workspace sekolah');
    }
    const workspaceId = user.workspaceId!;
    const { id } = request.params as { id: string };

    const pool = getPool(db);
    if (!pool) {
      return reply.status(503).send({
        error: { code: 'DB_UNAVAILABLE', message: 'Database tidak tersedia', requestId, retryable: true },
      });
    }

    // Fetch assessment (must belong to workspace and be finalized)
    const asmRes = await pool.query<{
      id: string;
      title: string;
      subject: string | null;
      grade: string | null;
      questionCount: number | null;
      createdAt: string;
      authorId: string | null;
      authorName: string | null;
      blueprint: unknown;
      status: string;
    }>(
      `SELECT
         a.id,
         a.title,
         '' AS subject,
         '' AS grade,
         0 AS "questionCount",
         a.created_at           AS "createdAt",
         a.creator_user_id            AS "authorId",
         COALESCE(u.name, u.email, a.creator_user_id::text) AS "authorName",
         NULL AS blueprint,
         a.status
       FROM assessments a
       LEFT JOIN jwt_users u ON u.id = a.creator_user_id
       WHERE a.id = $1
         AND a.workspace_id = $2
         AND a.status = 'finalized'`,
      [id, workspaceId],
    );

    if (asmRes.rows.length === 0) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Assessment tidak ditemukan', requestId, retryable: false },
      });
    }

    const assessment = asmRes.rows[0]!;

    // Fetch latest version
    const verRes = await pool.query<{
      id: string;
      version: number;
      createdAt: string;
      notes: string | null;
    }>(
      `SELECT id, version, created_at AS "createdAt", notes
       FROM assessment_versions
       WHERE assessment_id = $1
       ORDER BY version DESC
       LIMIT 1`,
      [id],
    );

    // Fetch reviewed questions summary
    const rqRes = await pool.query<{
      id: string;
      questionNo: number | null;
      type: string | null;
      status: string | null;
    }>(
      `SELECT rq.id, rq.question_no AS "questionNo", rq.question_type AS "type", rq.status
       FROM reviewed_questions rq
       WHERE rq.assessment_id = $1
       ORDER BY rq.question_no ASC`,
      [id],
    );

    return reply.status(200).send({
      data: {
        ...assessment,
        latestVersion: verRes.rows[0] ?? null,
        questions: rqRes.rows,
      },
    });
  });
}
