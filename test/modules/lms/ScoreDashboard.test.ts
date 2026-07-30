/**
 * LMS-F — Score Dashboard
 *
 * GET /v1/assessments/:assessmentId/scores
 * Returns submitted+graded attempts sorted by totalScore desc, submittedAt asc (tie-break).
 *
 * 3 tests:
 *  1. empty  — no attempts → data: []
 *  2. sorted — multiple graded attempts returned highest score first
 *  3. ungraded excluded — submitted but no gradingResult excluded from leaderboard
 */
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';

import { AttemptService } from '../../../src/modules/lms/application/AttemptService.js';
import { InMemoryAttemptStore } from '../../../src/modules/lms/persistence/InMemoryAttemptStore.js';
import { registerAttemptRoutes } from '../../../src/modules/lms/adapters/http/attemptRoutes.js';
import type { GradingQuestion } from '../../../src/modules/lms/domain/Attempt.js';

const ASSESSMENT_ID = 'assess-score-001';

const questions: GradingQuestion[] = [
  { questionId: 'q1', type: 'multiple_choice', answerKey: 'A' },
  { questionId: 'q2', type: 'multiple_choice', answerKey: 'B' },
  { questionId: 'q3', type: 'multiple_choice', answerKey: 'C' },
];

function makeApp() {
  const store = new InMemoryAttemptStore();
  const service = new AttemptService(store);
  const app = Fastify();
  registerAttemptRoutes(app, service);
  return { app, service };
}

describe('ScoreDashboard', () => {
  it('returns empty leaderboard when no attempts exist', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/assessments/${ASSESSMENT_ID}/scores`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [] });
  });

  it('returns graded attempts sorted by totalScore desc then submittedAt asc', async () => {
    const { app, service } = makeApp();

    // Score 1/3 — submitted first
    const a1 = await service.startGuestAttempt(ASSESSMENT_ID, 'Budi', '7A');
    await service.submitAttempt(a1.id, { q1: 'A', q2: 'X', q3: 'X' }, questions);

    // Score 3/3
    const a2 = await service.startGuestAttempt(ASSESSMENT_ID, 'Siti', '8B');
    await service.submitAttempt(a2.id, { q1: 'A', q2: 'B', q3: 'C' }, questions);

    // Score 2/3
    const a3 = await service.startGuestAttempt(ASSESSMENT_ID, 'Ahmad', '9C');
    await service.submitAttempt(a3.id, { q1: 'A', q2: 'B', q3: 'X' }, questions);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/assessments/${ASSESSMENT_ID}/scores`,
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();

    expect(data).toHaveLength(3);
    expect(data[0].guestName).toBe('Siti');
    expect(data[0].totalScore).toBe(3);
    expect(data[0].maxScore).toBe(3);
    expect(data[1].guestName).toBe('Ahmad');
    expect(data[1].totalScore).toBe(2);
    expect(data[2].guestName).toBe('Budi');
    expect(data[2].totalScore).toBe(1);

    // Shape check on first entry
    expect(data[0]).toMatchObject({
      attemptId: expect.any(String),
      guestName: 'Siti',
      guestClass: '8B',
      totalScore: 3,
      maxScore: 3,
      submittedAt: expect.any(String),
    });
  });

  it('excludes attempts that are submitted but not graded (no gradingResult)', async () => {
    const { app, service } = makeApp();

    // Graded attempt
    const a1 = await service.startGuestAttempt(ASSESSMENT_ID, 'Dewi', '7A');
    await service.submitAttempt(a1.id, { q1: 'A', q2: 'B', q3: 'C' }, questions);

    // Submitted without questions → no gradingResult
    const a2 = await service.startGuestAttempt(ASSESSMENT_ID, 'Rizki', '7B');
    await service.submitAttempt(a2.id, { q1: 'A' });

    // Not submitted at all
    await service.startGuestAttempt(ASSESSMENT_ID, 'Nur', '7C');

    const res = await app.inject({
      method: 'GET',
      url: `/v1/assessments/${ASSESSMENT_ID}/scores`,
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();

    expect(data).toHaveLength(1);
    expect(data[0].guestName).toBe('Dewi');
  });
});
