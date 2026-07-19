import { describe, expect, it } from 'vitest';

import { isApprovedSourceRights } from '../../../src/modules/curriculum/domain/CurriculumRepository.js';

describe('source rights matrix', () => {
  const cases = [
    ['license:internal', true],
    ['license:cc-by', true],
    ['license:cc-by-sa', true],
    ['license:cc-by-nc', false],
    ['license:cc-by-nd', false],
    ['license:unknown', false],
    ['', false],
  ] as const;

  it.each(cases)('license %s -> %s', (license, expected) => {
    expect(isApprovedSourceRights(license)).toBe(expected);
  });
});
