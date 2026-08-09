import type { FastifyInstance, FastifyRequest } from 'fastify';
import { buildErrorEnvelope } from '../../../../common/errors/envelope.js';
import {
  assessmentPrivateAuth,
  jwtWorkspace,
} from '../../../assessments/adapters/http/privateAuth.js';
import type { ShareLinkService } from '../../../assessments/application/ShareLinkService.js';
import type { AssessmentsStore } from '../../../assessments/domain/Assessment.js';
import type { QuestionGenerationStore } from '../../../assessments/domain/QuestionGeneration.js';
import {
  sanitizePublicQuestions,
  type AuthoritativeQuestion,
  type DurableAttemptService,
} from '../../application/DurableAttemptService.js';
const starts = new Map<string, number[]>();
export interface Options {
  service: DurableAttemptService;
  shareService: ShareLinkService;
  assessmentsStore: AssessmentsStore;
  questionStore: QuestionGenerationStore;
  jwtSecret: string;
}
const rid = (r: FastifyRequest) => (r.headers['x-request-id'] as string | undefined) ?? 'unknown';
async function context(o: Options, token: string, requestId: string) {
  const link = await o.shareService.validateToken(token, requestId);
  const assessment = await o.assessmentsStore.getAssessmentById(
    link.workspaceId,
    link.assessmentId,
  );
  const version = await o.assessmentsStore.getLatestVersion(link.workspaceId, link.assessmentId);
  const questions = version
    ? await o.questionStore.getQuestionsByAssessmentVersionId(link.workspaceId, version.id)
    : [];
  return { link, assessment, questions: questions as AuthoritativeQuestion[] };
}
function validAnswers(v: unknown): v is Record<string, string> {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === 'string' && x.length <= 10000)
  );
}
const csv = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
export async function registerDurableAttemptRoutes(app: FastifyInstance, o: Options) {
  app.get('/v1/public/shares/:token', async (r, reply) => {
    const { token } = r.params as { token: string };
    const c = await context(o, token, rid(r));
    return reply.send({
      data: {
        assessmentId: c.link.assessmentId,
        title: c.assessment?.title ?? null,
        expiresAt: c.link.expiresAt,
        questions: sanitizePublicQuestions(c.questions),
      },
    });
  });
  app.post('/v1/public/shares/:token/attempts', async (r, reply) => {
    const { token } = r.params as { token: string };
    const body = r.body as { guestName?: string; guestClass?: string };
    const name = body?.guestName?.trim(),
      klass = body?.guestClass?.trim();
    if (!name || name.length > 120 || (klass?.length ?? 0) > 80)
      return reply
        .code(400)
        .send(
          buildErrorEnvelope({
            code: 'VALIDATION_FAILED',
            message: 'Data peserta tidak valid.',
            requestId: rid(r),
          }),
        );
    const key = `${r.ip}:${token}`,
      now = Date.now(),
      hits = (starts.get(key) ?? []).filter((x) => x > now - 600000);
    if (hits.length >= 5)
      return reply
        .code(429)
        .send(
          buildErrorEnvelope({
            code: 'RATE_LIMITED',
            message: 'Terlalu banyak percobaan.',
            requestId: rid(r),
            retryable: true,
          }),
        );
    hits.push(now);
    starts.set(key, hits);
    const c = await context(o, token, rid(r));
    return reply.code(201).send({ data: await o.service.start(c.link, name, klass) });
  });
  app.put('/v1/public/shares/:token/attempts/:id/answers', async (r, reply) => {
    const { token, id } = r.params as { token: string; id: string };
    const c = await context(o, token, rid(r));
    const a = (r.body as { answers?: unknown })?.answers;
    if (!validAnswers(a))
      return reply
        .code(400)
        .send(
          buildErrorEnvelope({
            code: 'VALIDATION_FAILED',
            message: 'answers tidak valid.',
            requestId: rid(r),
          }),
        );
    return reply.send({ data: await o.service.autosave(id, a, c.link.id) });
  });
  app.post('/v1/public/shares/:token/attempts/:id/submit', async (r, reply) => {
    const { token, id } = r.params as { token: string; id: string };
    const c = await context(o, token, rid(r));
    const a = (r.body as { answers?: unknown })?.answers;
    if (a !== undefined) {
      if (!validAnswers(a))
        return reply
          .code(400)
          .send(
            buildErrorEnvelope({
              code: 'VALIDATION_FAILED',
              message: 'answers tidak valid.',
              requestId: rid(r),
            }),
          );
      await o.service.autosave(id, a, c.link.id);
    }
    return reply.send({ data: await o.service.submit(id, c.questions, c.link.id) });
  });
  const auth = assessmentPrivateAuth({ jwtSecret: o.jwtSecret });
  app.get('/v1/assessments/:assessmentId/results', { preHandler: auth }, async (r, reply) => {
    const { assessmentId } = r.params as { assessmentId: string };
    return reply.send({ data: await o.service.results(jwtWorkspace(r), assessmentId) });
  });
  app.get('/v1/assessments/:assessmentId/results.csv', { preHandler: auth }, async (r, reply) => {
    const { assessmentId } = r.params as { assessmentId: string };
    const rows = await o.service.results(jwtWorkspace(r), assessmentId);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .send(
        [
          'nama,kelas,skor,maks,perlu_penilaian,waktu_submit',
          ...rows.map((x) =>
            [x.guestName, x.guestClass, x.rawScore, x.maxScore, x.needsGrading, x.submittedAt]
              .map(csv)
              .join(','),
          ),
        ].join('\n'),
      );
  });
}
