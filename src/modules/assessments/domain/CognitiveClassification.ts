export const BLOOM_LEVELS = [
  'remember',
  'understand',
  'apply',
  'analyze',
  'evaluate',
  'create',
] as const;

export type BloomLevel = (typeof BLOOM_LEVELS)[number];
export type CognitiveBand = 'lots' | 'mots' | 'hots';

/**
 * Versioned product policy. Bloom remains canonical; LOTS/MOTS/HOTS is a
 * teacher-facing summary and must never replace the underlying Bloom level.
 */
export const COGNITIVE_BAND_POLICY_VERSION = 'bloom-band-v1' as const;

export function cognitiveBandForBloom(level: BloomLevel): CognitiveBand {
  switch (level) {
    case 'remember':
    case 'understand':
      return 'lots';
    case 'apply':
      return 'mots';
    case 'analyze':
    case 'evaluate':
    case 'create':
      return 'hots';
  }
}

export function isBloomLevel(value: string): value is BloomLevel {
  return (BLOOM_LEVELS as readonly string[]).includes(value);
}

export function cognitiveBandLabel(band: CognitiveBand): string {
  switch (band) {
    case 'lots':
      return 'LOTS';
    case 'mots':
      return 'MOTS';
    case 'hots':
      return 'HOTS';
  }
}
