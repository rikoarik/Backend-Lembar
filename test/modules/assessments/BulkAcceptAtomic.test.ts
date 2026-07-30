/**
 * P0-F: bulkAccept is atomic — if any setStatus throws after partial updates,
 * already-updated ids are rolled back to 'pending' and result.updated is empty.
 */
import { describe, expect, it } from 'vitest';

import { QuestionReviewService } from '../../../src/modules/assessments/application/QuestionReviewService.js';
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

describe('P0-F: bulkAccept atomicity', () => {
  it('rolls back the first two accepted ids when the store throws on the 3rd, and result.updated is empty', async () => {
    const store = new InMemoryQuestionReviewStore();
    const service = new QuestionReviewService({ store });

    // Import three pending questions
    const q1 = await service.importQuestion(makeGeneratedQuestion('gq-1'), 'user-1');
    const q2 = await service.importQuestion(makeGeneratedQuestion('gq-2'), 'user-1');
    const q3 = await service.importQuestion(makeGeneratedQuestion('gq-3'), 'user-1');

    const originalSave = store.save.bind(store);
    store.save = async (q) => {
      if (q.id === q3.id && q.status === 'accepted') {
        throw new Error('store failure on q3');
      }
      return originalSave(q);
    };

    const result = await service.bulkAccept('ws-1', 'version-1', [q1.id, q2.id, q3.id], 'user-1');

    expect(result.updated).toEqual([]);

    // Both q1 and q2 must be rolled back to 'pending'
    await expect(store.findById('ws-1', q1.id)).resolves.toMatchObject({ status: 'pending' });
    await expect(store.findById('ws-1', q2.id)).resolves.toMatchObject({ status: 'pending' });
    // q3 never succeeded
    await expect(store.findById('ws-1', q3.id)).resolves.toMatchObject({ status: 'pending' });
  });
});
