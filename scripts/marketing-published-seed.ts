const heroCta = {
  id: 'hero-cta',
  label: 'Coba sekarang',
  href: '/register',
  variant: 'primary' as const,
  placement: 'hero' as const,
  audience: 'all' as const,
  trackingKey: 'hero_cta',
  enabled: true,
  external: false,
  accessibleLabel: 'Coba sekarang',
};

function pagePayload({ title, heading, body }: { title: string; heading: string; body: string }) {
  return {
    schemaVersion: 1 as const,
    blocks: [{
      id: 'hero-1', type: 'hero' as const, eyebrow: 'lembar', heading, body,
      theme: 'light' as const, mediaAssetId: null, ctas: [heroCta], items: [] as unknown[],
    }],
    seo: { title, description: body, imageAssetId: null, noIndex: false },
  };
}

export const MARKETING_PUBLISHED_SEED_DOCUMENTS = [
  { kind: 'global' as const, slug: '__global__', payload: { navigation: [
    { id: 'nav-home', title: 'Beranda', body: null, mediaAssetId: null, cta: null },
    { id: 'nav-school', title: 'Untuk Sekolah', body: null, mediaAssetId: null, cta: null },
    { id: 'nav-pricing', title: 'Harga', body: null, mediaAssetId: null, cta: null },
  ], footer: [{ id: 'footer-about', title: 'Tentang lembar', body: 'Platform asesmen berbasis kurikulum untuk guru dan sekolah.', mediaAssetId: null, cta: null }],
    ctas: [{ ...heroCta, id: 'cta-start', placement: 'header' as const, trackingKey: 'cta_start_header' }] } },
  { kind: 'page' as const, slug: 'home', payload: pagePayload({ title: 'lembar — asesmen untuk guru', heading: 'Asesmen kurikulum yang rapi', body: 'Buat, review, dan cetak asesmen dengan alur kerja yang jelas.' }) },
  { kind: 'page' as const, slug: 'untuk-sekolah', payload: pagePayload({ title: 'lembar untuk sekolah', heading: 'Workspace Organisasi untuk Institusi Sekolah', body: 'Sentralisasi pembuatan soal dan manajemen akun guru dalam satu dasbor yang aman.' }) },
  { kind: 'page' as const, slug: 'harga', payload: pagePayload({ title: 'Harga lembar — paket untuk guru dan sekolah', heading: 'Pilih paket yang sesuai untuk kebutuhan mengajar Anda.', body: 'Temukan pilihan paket untuk kebutuhan guru dan sekolah.' }) },
];
