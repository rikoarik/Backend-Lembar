import { describe, expect, it } from 'vitest';

import { MARKETING_PUBLISHED_SEED_DOCUMENTS } from '../../../scripts/marketing-published-seed.js';

describe('default published marketing seed documents', () => {
  it('includes schema-shaped published documents for global slots and every allowed public page', () => {
    expect(MARKETING_PUBLISHED_SEED_DOCUMENTS.map((document) => document.slug)).toEqual([
      '__global__',
      'home',
      'untuk-sekolah',
      'harga',
    ]);

    const global = MARKETING_PUBLISHED_SEED_DOCUMENTS[0];
    expect(global).toMatchObject({
      kind: 'global',
      slug: '__global__',
      payload: {
        navigation: expect.any(Array),
        footer: expect.any(Array),
        ctas: expect.any(Array),
      },
    });

    for (const document of MARKETING_PUBLISHED_SEED_DOCUMENTS.slice(1)) {
      expect(document).toMatchObject({
        kind: 'page',
        payload: {
          schemaVersion: 1,
          blocks: expect.any(Array),
          seo: { title: expect.any(String), description: expect.any(String) },
        },
      });
      expect(document.payload).not.toHaveProperty('state');
      expect(document.payload).not.toHaveProperty('revision');
    }
  });
});
