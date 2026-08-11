import { describe, expect, it } from 'vitest';

import { mapWorkspacePlanSummary } from '../../../src/modules/admin/adapters/http/accountPlanSummary.js';

describe('mapWorkspacePlanSummary', () => {
  it('maps usage and catalog limit only for the matched workspace plan', () => {
    expect(
      mapWorkspacePlanSummary({
        plan_key: 'free',
        token_used_this_month: '12345',
        token_monthly_limit: '60000',
      }),
    ).toEqual({
      planKey: 'free',
      tokenUsedThisMonth: 12345,
      tokenMonthlyLimit: 60000,
    });
  });

  it('preserves a null catalog limit as unlimited', () => {
    expect(
      mapWorkspacePlanSummary({
        plan_key: 'pro',
        token_used_this_month: '987654',
        token_monthly_limit: null,
      }),
    ).toEqual({
      planKey: 'pro',
      tokenUsedThisMonth: 987654,
      tokenMonthlyLimit: null,
    });
  });

  it('does not fabricate a summary when no tenant-scoped workspace plan matched', () => {
    expect(mapWorkspacePlanSummary({ plan_key: null })).toBeNull();
  });
});
