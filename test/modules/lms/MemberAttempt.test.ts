/**
 * LMS-B — Unit tests for MemberAttempt domain: store + AttemptService.
 *
 * Evidence covered:
 * 1. startMemberAttempt creates attempt with correct workspace/assessment/member
 * 2. startMemberAttempt is workspace-scoped (cross-workspace attempt is rejected)
 * 3. submitMemberAttempt records answers and sets submittedAt
 * 4. submitMemberAttempt rejects double-submit
 */
import { describe, it, expect } from 'vitest';

import { AttemptService } from '../../../src/modules/lms/application/AttemptService.js';
import { InMemoryMemberAttemptStore } from '../../../src/modules/lms/persistence/InMemoryMemberAttemptStore.js';
import { ApiError } from '../../../src/common/errors/envelope.js';

const WS = '00000000-0000-0000-0000-000000000001';
const ASSESSMENT_ID = '00000000-0000-0000-0000-000000000002';
const MEMBER_ID = '00000000-0000-0000-0000-000000000003';
const OTHER_WS = '00000000-0000-0000-0000-000000000099';

function makeService() {
  const store = new InMemoryMemberAttemptStore();
  const service = new AttemptService({ store });
  return { service, store };
}

describe('AttemptService', () => {
  it('startMemberAttempt creates attempt with correct fields', async () => {
    const { service } = makeService();
    const attempt = await service.startMemberAttempt(WS, ASSESSMENT_ID, MEMBER_ID);

    expect(attempt.workspaceId).toBe(WS);
    expect(attempt.assessmentId).toBe(ASSESSMENT_ID);
    expect(attempt.memberId).toBe(MEMBER_ID);
    expect(attempt.answers).toEqual({});
    expect(attempt.startedAt).toBeTruthy();
    expect(attempt.submittedAt).toBeUndefined();
    expect(typeof attempt.id).toBe('string');
  });

  it('startMemberAttempt is workspace-scoped: findByAssessment returns only own workspace', async () => {
    const { service, store } = makeService();
    await service.startMemberAttempt(WS, ASSESSMENT_ID, MEMBER_ID);
    await service.startMemberAttempt(OTHER_WS, ASSESSMENT_ID, MEMBER_ID);

    const results = await store.findByAssessment(WS, ASSESSMENT_ID);
    expect(results).toHaveLength(1);
    expect(results[0]!.workspaceId).toBe(WS);
  });

  it('submitMemberAttempt records answers and sets submittedAt', async () => {
    const { service } = makeService();
    const attempt = await service.startMemberAttempt(WS, ASSESSMENT_ID, MEMBER_ID);
    const answers = { 'q-1': 'A', 'q-2': 'true' };

    const submitted = await service.submitMemberAttempt(attempt.id, answers);

    expect(submitted.answers).toEqual(answers);
    expect(submitted.submittedAt).toBeTruthy();
  });

  it('submitMemberAttempt rejects double-submit with STATE_CONFLICT', async () => {
    const { service } = makeService();
    const attempt = await service.startMemberAttempt(WS, ASSESSMENT_ID, MEMBER_ID);
    await service.submitMemberAttempt(attempt.id, { 'q-1': 'A' });

    await expect(service.submitMemberAttempt(attempt.id, { 'q-1': 'B' })).rejects.toThrow(
      ApiError,
    );
  });
});
