import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerDurableAttemptRoutes } from '../../../src/modules/lms/adapters/http/durableAttemptRoutes.js';
import {
  sanitizePublicQuestions,
  gradeAnswers,
} from '../../../src/modules/lms/application/DurableAttemptService.js';

const questions = [
  {
    id: 'q1',
    questionType: 'multiple_choice',
    stem: '2+2?',
    options: [{ key: 'A', text: '4' }],
    answer: 'A',
    explanation: 'math',
  },
  {
    id: 'q2',
    questionType: 'essay',
    stem: 'why?',
    options: [],
    answer: 'because',
    explanation: 'secret',
  },
];

describe('durable public assessment contract', () => {
  it('never exposes answer or explanation in public questions', () => {
    const output = sanitizePublicQuestions(questions);
    expect(JSON.stringify(output)).not.toContain('math');
    expect(JSON.stringify(output)).not.toContain('secret');
    expect(output[0]).not.toHaveProperty('answer');
    expect(output[0]).not.toHaveProperty('explanation');
  });

  it('grades objective authoritatively and flags open answers', () => {
    expect(gradeAnswers({ q1: 'A', q2: 'invented' }, questions)).toEqual({
      rawScore: 1,
      maxScore: 1,
      needsGrading: true,
      answers: [
        { questionId: 'q1', value: 'A', isCorrect: true, score: 1, needsGrading: false },
        { questionId: 'q2', value: 'invented', isCorrect: null, score: null, needsGrading: true },
      ],
    });
  });

  it('teacher results reject a public caller', async () => {
    const app = Fastify();
    await registerDurableAttemptRoutes(app, {
      service: {} as never,
      shareService: {} as never,
      assessmentsStore: {} as never,
      questionStore: {} as never,
      jwtSecret: 'test-secret',
    });
    const response = await app.inject({ method: 'GET', url: '/v1/assessments/a/results' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe('migration contract', () => {
  it('defines durable attempts, answer key and lifecycle constraints', async () => {
    const sql = await import('node:fs/promises').then((fs) =>
      fs.readFile('src/infrastructure/database/migrations/0028_assessment_attempts.sql', 'utf8'),
    );
    expect(sql).toContain('assessment_attempts');
    expect(sql).toContain('assessment_attempt_answers');
    expect(sql).toMatch(/UNIQUE\s*\(attempt_id, question_id\)/i);
    expect(sql).toContain("'in_progress', 'submitted'");
  });
});

it('Postgres store exists so attempts survive service recreation', async () => {
  const module = await import('../../../src/modules/lms/persistence/PostgresAttemptStore.js');
  expect(module.PostgresAttemptStore).toBeTypeOf('function');
});
