/**
 * LMS-H — Score Export as CSV
 *
 * GET /v1/assessments/:assessmentId/scores/export
 * Returns text/csv with header: nama,kelas,skor,maks,persen,waktu_submit
 * Rows sorted by skor desc (same order as score dashboard).
 *
 * 3 tests:
 *  1. CSV header correct — response Content-Type is text/csv, first line is the header
 *  2. rows sorted by score desc — multiple graded attempts in correct order
 *  3. empty = header only — no attempts → only header line, no data rows
 */
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';

import { AttemptService } from '../../../src/modules/lms/application/AttemptService.js';
import { InMemoryAttemptStore } from '../../../src/modules/lms/persistence/InMemoryAttemptStore.js';
import { registerAttemptRoutes } from '../../../src/modules/lms/adapters/http/attemptRoutes.js';
import type { GradingQuestion } from '../../../src/modules/lms/domain/Attempt.js';

const ASSESSMENT_ID = 'assess-export-001';

const questions: GradingQuestion[] = [
  { questionId: 'q1', type: 'multiple_choice', answerKey: 'A' },
  { questionId: 'q2', type: 'multiple_choice', answerKey: 'B' },
  { questionId: 'q3', type: 'multiple_choice', answerKey: 'C' },
  { questionId: 'q4', type: 'multiple_choice', answerKey: 'D' },
];

function makeApp() {
  const store = new InMemoryAttemptStore();
  const service = new AttemptService({ guestStore: store });
  const app = Fastify();
  registerAttemptRoutes(app, service);
  return { app, service };
}

const CSV_HEADER = 'nama,kelas,skor,maks,persen,waktu_submit';

describe('ScoreExport', () => {
  it('returns text/csv with correct header line', async () => {
    const { app } = makeApp();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/assessments/${ASSESSMENT_ID}/scores/export`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);

    const lines = res.body.trim().split('\n');
    expect(lines[0]).toBe(CSV_HEADER);
  });

  it('rows sorted by score desc, values correct', async () => {
    const { app, service } = makeApp();

    // Score 2/4 (50%)
    const a1 = await service.startGuestAttempt(ASSESSMENT_ID, 'Budi', '7A');
    await service.submitAttempt(a1.id, { q1: 'A', q2: 'B', q3: 'X', q4: 'X' }, questions);

    // Score 4/4 (100%)
    const a2 = await service.startGuestAttempt(ASSESSMENT_ID, 'Siti', '8B');
    await service.submitAttempt(a2.id, { q1: 'A', q2: 'B', q3: 'C', q4: 'D' }, questions);

    // Score 3/4 (75%)
    const a3 = await service.startGuestAttempt(ASSESSMENT_ID, 'Ahmad', '9C');
    await service.submitAttempt(a3.id, { q1: 'A', q2: 'B', q3: 'C', q4: 'X' }, questions);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/assessments/${ASSESSMENT_ID}/scores/export`,
    });

    expect(res.statusCode).toBe(200);

    const lines = res.body.trim().split('\n');
    // header + 3 data rows
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(CSV_HEADER);

    const [sitiRow, ahmadRow, budiRow] = lines.slice(1);
    if (!sitiRow || !ahmadRow || !budiRow) {
      throw new Error('Expected three score export rows');
    }

    // Row 1: Siti 4/4 = 100%
    const [nama1, kelas1, skor1, maks1, persen1] = sitiRow.split(',');
    expect(nama1).toBe('Siti');
    expect(kelas1).toBe('8B');
    expect(skor1).toBe('4');
    expect(maks1).toBe('4');
    expect(persen1).toBe('100.00');

    // Row 2: Ahmad 3/4 = 75%
    const [nama2, , skor2, , persen2] = ahmadRow.split(',');
    expect(nama2).toBe('Ahmad');
    expect(skor2).toBe('3');
    expect(persen2).toBe('75.00');

    // Row 3: Budi 2/4 = 50%
    const [nama3, , skor3, , persen3] = budiRow.split(',');
    expect(nama3).toBe('Budi');
    expect(skor3).toBe('2');
    expect(persen3).toBe('50.00');
  });

  it('returns header only when no attempts exist', async () => {
    const { app } = makeApp();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/assessments/${ASSESSMENT_ID}/scores/export`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);

    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(CSV_HEADER);
  });
});
