import Fastify from 'fastify';
import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';
import { describe, expect, it } from 'vitest';

import { QuestionReviewService } from '../../../src/modules/assessments/application/QuestionReviewService.js';
import { registerQuestionReviewRoutes } from '../../../src/modules/assessments/adapters/http/questionReviewRoutes.js';
import { FinalizationService } from '../../../src/modules/assessments/application/FinalizationService.js';
import type { GeneratedQuestion } from '../../../src/modules/assessments/domain/QuestionGeneration.js';
import { InMemoryQuestionReviewStore } from '../../../src/modules/assessments/persistence/InMemoryQuestionReviewStore.js';

function makeGeneratedQuestion(
  id: string,
  workspaceId = 'ws-1',
  assessmentVersionId = 'version-1',
): GeneratedQuestion {
  return {
    id,
    assessmentVersionId,
    workspaceId,
    blueprintSequence: Number(id.replace(/\D/g, '')) || 0,
    questionType: 'multiple_choice',
    difficulty: 'medium',
    stem: `Question ${id}?`,
    options: [
      { key: 'A', text: 'Option A' },
      { key: 'B', text: 'Option B' },
    ],
    answer: 'A',
    explanation: 'Because A.',
    sourceIds: [`source-${id}`],
    versionMetadata: {
      blueprintSchemaVersion: '1.0.0',
      providerModelId: 'test-model',
      promptTemplateId: 'test-template',
      schemaRepairAttempts: 0,
      latencyMs: 1,
    },
    createdAt: '2024-01-01T00:00:00.000Z',
  };
}

describe('P0-E: bulk accept reviewed questions', () => {
  it('accepts pending questions, skips already accepted, and reports unknown ids as conflicted', async () => {
    const store = new InMemoryQuestionReviewStore();
    const service = new QuestionReviewService({ store });
    const pending = await service.importQuestion(makeGeneratedQuestion('gq-1'), 'user-1');
    const accepted = await service.importQuestion(makeGeneratedQuestion('gq-2'), 'user-1');
    await service.setStatus('ws-1', accepted.id, 'accepted', 'user-1');

    const result = await service.bulkAccept('ws-1', 'version-1', [pending.id, accepted.id, 'missing'], 'user-1');

    expect(result).toEqual({
      requested: 3,
      updated: [pending.id],
      conflicted: ['missing'],
      skipped: [accepted.id],
    });
    await expect(store.findById('ws-1', pending.id)).resolves.toMatchObject({ status: 'accepted' });
  });

  it('does not accept questions from another tenant', async () => {
    const store = new InMemoryQuestionReviewStore();
    const service = new QuestionReviewService({ store });
    const otherTenantQuestion = await service.importQuestion(
      makeGeneratedQuestion('gq-3', 'ws-2', 'version-1'),
      'user-1',
    );

    const result = await service.bulkAccept(
      'ws-1',
      'version-1',
      [otherTenantQuestion.id],
      'user-1',
    );

    expect(result).toEqual({
      requested: 1,
      updated: [],
      conflicted: [otherTenantQuestion.id],
      skipped: [],
    });
    await expect(store.findById('ws-2', otherTenantQuestion.id)).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('exposes POST bulk-accept route', async () => {
    const store = new InMemoryQuestionReviewStore();
    const reviewService = new QuestionReviewService({ store });
    const finalizationService = new FinalizationService({ store, reviewService });
    const question = await reviewService.importQuestion(makeGeneratedQuestion('gq-4'), 'user-1');
    const app = Fastify();
    const secret = 'bulk-accept-test-secret';
    await registerQuestionReviewRoutes(app, reviewService, finalizationService, { jwtSecret: secret });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/ws-1/assessments/assessment-1/versions/version-1/bulk-accept',
      headers: { authorization: `Bearer ${generateJwt({ userId: 'user-1', email: 'user@example.test', roles: ['teacher'], workspaceId: 'ws-1' }, { secret, expiryDays: 1 })}` },
      payload: { questionIds: [question.id, 'missing'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      requested: 2,
      updated: [question.id],
      conflicted: ['missing'],
      skipped: [],
    });
    await app.close();
  });
});
