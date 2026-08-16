import { describe, expect, it } from 'vitest';

import { PERMISSIONS, permissionsForRole } from '../../../src/modules/auth/policy/Permissions.js';

describe('subscriber permissions', () => {
  it('keeps the same teacher workspace capabilities without school admin access', () => {
    expect(permissionsForRole('subscriber')).toEqual(
      expect.arrayContaining([
        PERMISSIONS.assessmentCreate,
        PERMISSIONS.assessmentRead,
        PERMISSIONS.assessmentReview,
        PERMISSIONS.sourceManage,
      ]),
    );
    expect(permissionsForRole('subscriber')).not.toContain(PERMISSIONS.workspaceMemberManage);
  });
});
