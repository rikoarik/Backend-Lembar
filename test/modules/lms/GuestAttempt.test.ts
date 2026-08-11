/**
 * LMS-A — Guest Attempt Session Foundation
 *
 * 4 tests: start, submit, retrieve, isolation.
 */
import { describe, it, expect } from 'vitest';

import { AttemptService } from '../../../src/modules/lms/application/AttemptService.js';
import { InMemoryAttemptStore } from '../../../src/modules/lms/persistence/InMemoryAttemptStore.js';

const ASSESSMENT_ID = 'assess-001';
const ASSESSMENT_ID_2 = 'assess-002';

function makeService() {
  const store = new InMemoryAttemptStore();
  const service = new AttemptService({ guestStore: store });
  return { store, service };
}

describe('GuestAttempt', () => {
  it('starts a guest attempt with correct initial state', async () => {
    const { service } = makeService();

    const attempt = await service.startGuestAttempt(ASSESSMENT_ID, 'Budi Santoso', '7A');

    expect(attempt.id).toBeTruthy();
    expect(attempt.assessmentId).toBe(ASSESSMENT_ID);
    expect(attempt.guestName).toBe('Budi Santoso');
    expect(attempt.guestClass).toBe('7A');
    expect(attempt.startedAt).toBeTruthy();
    expect(attempt.answers).toEqual({});
    expect(attempt.submittedAt).toBeUndefined();
  });

  it('submits an attempt with answers and records submittedAt', async () => {
    const { service } = makeService();
    const attempt = await service.startGuestAttempt(ASSESSMENT_ID, 'Siti Rahayu');

    const answers = { 'q-1': 'A', 'q-2': 'C', 'q-3': 'Jawaban essay' };
    const submitted = await service.submitAttempt(attempt.id, answers);

    expect(submitted.answers).toEqual(answers);
    expect(submitted.submittedAt).toBeTruthy();
    expect(submitted.id).toBe(attempt.id);
  });

  it('retrieves a stored attempt by id', async () => {
    const { service, store } = makeService();
    const attempt = await service.startGuestAttempt(ASSESSMENT_ID, 'Ahmad Fauzi', '8B');

    const found = await store.findById(attempt.id);

    expect(found).not.toBeNull();
    expect(found!.id).toBe(attempt.id);
    expect(found!.guestName).toBe('Ahmad Fauzi');
  });

  it('isolates attempts across different assessments', async () => {
    const { service, store } = makeService();
    await service.startGuestAttempt(ASSESSMENT_ID, 'Dewi Lestari', '9A');
    await service.startGuestAttempt(ASSESSMENT_ID, 'Rizki Pratama', '9B');
    await service.startGuestAttempt(ASSESSMENT_ID_2, 'Nur Hidayah', '7C');

    const forAssess1 = await store.findByAssessment(ASSESSMENT_ID);
    const forAssess2 = await store.findByAssessment(ASSESSMENT_ID_2);

    expect(forAssess1).toHaveLength(2);
    expect(forAssess2).toHaveLength(1);
    expect(forAssess2[0]!.guestName).toBe('Nur Hidayah');
  });
});
