export const MARKETING_LOCALE = 'id-ID';
export const MARKETING_GLOBAL_SLUG = '__global__';
export const MARKETING_PAGE_SLUGS = ['home', 'untuk-sekolah', 'harga'] as const;

export type MarketingPageSlug = (typeof MARKETING_PAGE_SLUGS)[number];
export type MarketingKind = 'global' | 'page';

export interface MarketingCta {
  id: string;
  label: string;
  href: string;
  variant: 'primary' | 'secondary' | 'text';
  placement: string;
  audience: 'all' | 'teacher' | 'school';
  trackingKey: string;
  enabled: boolean;
  external?: boolean;
  accessibleLabel?: string | null;
}

export interface MarketingBlockItem {
  id: string;
  title: string;
  body?: string | null;
  mediaAssetId?: string | null;
  cta?: MarketingCta | null;
}

export interface MarketingSeo {
  title: string;
  description: string;
  imageAssetId?: string | null;
  noIndex?: boolean;
}

export interface MarketingBlock {
  id: string;
  type:
    'hero' | 'product_proof' | 'workflow' | 'audience' | 'trust' | 'pricing' | 'faq' | 'final_cta';
  eyebrow?: string | null;
  heading?: string | null;
  body?: string | null;
  theme?: 'light' | 'dark' | 'accent';
  mediaAssetId?: string | null;
  ctas?: MarketingCta[];
  items?: MarketingBlockItem[];
}

export interface MarketingPageDocument {
  slug: MarketingPageSlug;
  locale: typeof MARKETING_LOCALE;
  schemaVersion: number;
  version: number;
  blocks: MarketingBlock[];
  seo: MarketingSeo;
}

export interface MarketingGlobalDocument {
  locale: typeof MARKETING_LOCALE;
  version: number;
  navigation: MarketingBlockItem[];
  footer: MarketingBlockItem[];
  ctas: MarketingCta[];
}

export interface PublishedMarketing<T> {
  etag: string;
  data: T;
}
