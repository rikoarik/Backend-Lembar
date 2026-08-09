import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';
import { registerAssessmentRoutes } from '../../../src/modules/assessments/adapters/http/routes.js';
import { registerQuestionReviewRoutes } from '../../../src/modules/assessments/adapters/http/questionReviewRoutes.js';
import { registerPrintRoutes } from '../../../src/modules/assessments/adapters/http/printRoutes.js';
import { registerArtifactRoutes } from '../../../src/modules/assessments/adapters/http/artifactRoutes.js';
import { registerShareRoutes } from '../../../src/modules/assessments/adapters/http/shareRoutes.js';

const SECRET = 'assessment-route-secret';
const WORKSPACE = 'ws-owner';
const token = generateJwt(
  { userId: 'user-owner', email: 'owner@example.test', roles: ['teacher'], workspaceId: WORKSPACE },
  { secret: SECRET, expiryDays: 1 },
);
const auth = { authorization: `Bearer ${token}`, 'x-workspace-id': 'ws-attacker' };

async function appWithRoutes() {
  const app = Fastify({ logger: false });
  const assessment = {
    createConfig: vi.fn(async (input) => ({ assessment: { workspaceId: input.workspaceId }, version: {}, blueprintItems: [], idempotent: false })),
    listAssessments: vi.fn(async (workspaceId) => [{ workspaceId }]),
    getAssessment: vi.fn(async (workspaceId) => ({ workspaceId })),
  };
  const review = {
    bulkAccept: vi.fn(async (workspaceId) => ({ workspaceId })),
    listQuestions: vi.fn(async (workspaceId) => [{ workspaceId }]),
    getQuestion: vi.fn(async (workspaceId) => ({ workspaceId, etag: '1' })),
    editQuestion: vi.fn(async (workspaceId, _id, _edits, actorUserId) => ({ workspaceId, actorUserId, etag: '2' })),
    deleteQuestion: vi.fn(async () => undefined), getAuditLog: vi.fn(async () => []),
    createCandidate: vi.fn(async () => ({ created: true, original: {}, candidate: {} })),
    acceptCandidate: vi.fn(async () => ({ etag: '1' })), rejectCandidate: vi.fn(async () => ({ etag: '1' })),
  };
  const finalize = { finalizeAssessmentVersion: vi.fn(async (workspaceId, _id, actorUserId) => ({ workspaceId, actorUserId })) };
  const print = { buildPrintDocument: vi.fn(async (workspaceId) => ({ workspaceId })) };
  const artifact = {
    triggerRender: vi.fn(async (workspaceId) => ({ reused: true, artifact: { id: 'a', status: 'ready', contentType: 'text/html', byteSize: 1, contentHash: 'h', createdAt: '' }, workspaceId })),
    getArtifactInfo: vi.fn(async (workspaceId) => ({ artifact: { id: 'a', status: 'ready', contentType: 'text/html', byteSize: 1, contentHash: 'h', createdAt: '' }, downloadUrl: 'url', expiresAtEpochMs: 1, workspaceId })),
  };
  const share = {
    listByAssessment: vi.fn(async (workspaceId) => [{ id: 's', token: 't', assessmentId: 'a', expiresAt: '', createdAt: '', workspaceId }]),
    createShareLink: vi.fn(async (input) => ({ id: 's', token: 't', assessmentId: input.assessmentId, expiresAt: '', createdAt: '', workspaceId: input.workspaceId })),
    validateToken: vi.fn(async () => ({ workspaceId: WORKSPACE, assessmentId: 'a', expiresAt: '' })),
    revokeShareLink: vi.fn(async (_token, workspaceId) => ({ id: 's', token: 't', revokedAt: '', workspaceId })),
  };
  await registerAssessmentRoutes(app, assessment as never, { jwtSecret: SECRET });
  await registerQuestionReviewRoutes(app, review as never, finalize as never, { jwtSecret: SECRET });
  await registerPrintRoutes(app, print as never, { jwtSecret: SECRET });
  await registerArtifactRoutes(app, artifact as never, { jwtSecret: SECRET });
  await registerShareRoutes(app, share as never, { jwtSecret: SECRET });
  await app.ready();
  return { app, assessment, review, finalize, print, artifact, share };
}

const privateRequests = [
  ['POST', `/v1/workspaces/${WORKSPACE}/assessments`, { title: 'T', curriculumVersionId: 'c', blueprintItems: [{ sequence: 1, questionType: 'essay', difficulty: 'easy' }] }],
  ['GET', `/v1/workspaces/${WORKSPACE}/assessments`], ['GET', `/v1/workspaces/${WORKSPACE}/assessments/a`],
  ['GET', `/v1/workspaces/${WORKSPACE}/assessments/a/versions/v/questions`],
  ['GET', `/v1/workspaces/${WORKSPACE}/assessments/a/versions/v/questions/q`],
  ['PATCH', `/v1/workspaces/${WORKSPACE}/assessments/a/versions/v/questions/q`, {}],
  ['DELETE', `/v1/workspaces/${WORKSPACE}/assessments/a/versions/v/questions/q`],
  ['GET', `/v1/workspaces/${WORKSPACE}/assessments/a/versions/v/questions/q/audit`],
  ['POST', `/v1/workspaces/${WORKSPACE}/assessments/a/versions/v/finalize`],
  ['GET', '/v1/assessments/a/print'], ['POST', '/v1/assessments/a/output'], ['GET', '/v1/assessments/a/output'],
  ['GET', '/v1/shares?assessmentId=a'], ['POST', '/v1/shares', { assessmentId: 'a' }], ['DELETE', '/v1/shares/t/revoke'],
] as const;

describe('assessment private route JWT hardening', () => {
  it('rejects every private surface when only spoofable workspace headers are supplied', async () => {
    const { app } = await appWithRoutes();
    for (const [method, url, payload] of privateRequests) {
      const response = await app.inject({ method, url, headers: { 'x-workspace-id': WORKSPACE, 'x-actor-user-id': 'attacker' }, ...(payload ? { payload } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('rejects path workspace mismatch instead of authorizing from the path', async () => {
    const { app, assessment } = await appWithRoutes();
    const response = await app.inject({ method: 'GET', url: '/v1/workspaces/ws-attacker/assessments', headers: auth });
    expect(response.statusCode).toBe(403);
    expect(assessment.listAssessments).not.toHaveBeenCalled();
  });

  it('derives workspace and actor from verified JWT while ignoring spoof headers', async () => {
    const { app, assessment, review } = await appWithRoutes();
    const list = await app.inject({ method: 'GET', url: `/v1/workspaces/${WORKSPACE}/assessments`, headers: auth });
    expect(list.statusCode).toBe(200);
    expect(assessment.listAssessments).toHaveBeenCalledWith(WORKSPACE, expect.anything());
    const edit = await app.inject({ method: 'PATCH', url: `/v1/workspaces/${WORKSPACE}/assessments/a/versions/v/questions/q`, headers: auth, payload: {} });
    expect(edit.statusCode).toBe(200);
    expect(review.editQuestion).toHaveBeenCalledWith(WORKSPACE, 'q', expect.anything(), 'user-owner');
  });

  it('keeps public share GET capability-scoped without JWT', async () => {
    const { app, share } = await appWithRoutes();
    const response = await app.inject({ method: 'GET', url: '/v1/shares/public-token', headers: { 'x-workspace-id': 'ws-attacker' } });
    expect(response.statusCode).toBe(200);
    expect(share.validateToken).toHaveBeenCalledWith('public-token', expect.any(String));
  });
});
