import { describe, expect, it } from 'vitest';

import {
  COGNITIVE_BAND_POLICY_VERSION,
  cognitiveBandForBloom,
  cognitiveBandLabel,
  isBloomLevel,
} from '../../../src/modules/assessments/domain/CognitiveClassification.js';

describe('CognitiveClassification', () => {
  it('maps Bloom levels to a stable teacher-facing band', () => {
    expect(COGNITIVE_BAND_POLICY_VERSION).toBe('bloom-band-v1');
    expect(cognitiveBandForBloom('remember')).toBe('lots');
    expect(cognitiveBandForBloom('understand')).toBe('lots');
    expect(cognitiveBandForBloom('apply')).toBe('mots');
    expect(cognitiveBandForBloom('analyze')).toBe('hots');
    expect(cognitiveBandForBloom('evaluate')).toBe('hots');
    expect(cognitiveBandForBloom('create')).toBe('hots');
  });

  it('keeps Bloom validation and presentation labels explicit', () => {
    expect(isBloomLevel('analyze')).toBe(true);
    expect(isBloomLevel('HOTS')).toBe(false);
    expect(cognitiveBandLabel('hots')).toBe('HOTS');
  });
});
