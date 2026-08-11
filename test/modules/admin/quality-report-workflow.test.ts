import { describe, expect, it } from 'vitest';

import {
  QUALITY_REPORT_NOTE_MAX_LENGTH,
  validateQualityReportUpdate,
} from '../../../src/modules/admin/application/qualityReportWorkflow.js';

describe('quality report update workflow', () => {
  it('only permits forward lifecycle transitions with an expected current status', () => {
    expect(validateQualityReportUpdate({ status: 'triaged', expectedStatus: 'open' })).toEqual({
      ok: true,
      update: { status: 'triaged', expectedStatus: 'open' },
    });
    expect(
      validateQualityReportUpdate({ status: 'open', expectedStatus: 'triaged' }),
    ).toMatchObject({
      ok: false,
      code: 'INVALID_STATUS_TRANSITION',
    });
    expect(
      validateQualityReportUpdate({ status: 'closed', expectedStatus: 'closed' }),
    ).toMatchObject({
      ok: false,
      code: 'INVALID_STATUS_TRANSITION',
    });
  });

  it('requires expectedStatus for every state change and rejects unknown statuses', () => {
    expect(validateQualityReportUpdate({ status: 'closed' })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
    expect(
      validateQualityReportUpdate({ status: 'deleted', expectedStatus: 'open' }),
    ).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
  });

  it('normalizes internal notes and bounds their size', () => {
    expect(validateQualityReportUpdate({ notes: '  perlu cek sumber  ' })).toEqual({
      ok: true,
      update: { notes: 'perlu cek sumber' },
    });
    expect(
      validateQualityReportUpdate({ notes: 'x'.repeat(QUALITY_REPORT_NOTE_MAX_LENGTH + 1) }),
    ).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
  });
});
