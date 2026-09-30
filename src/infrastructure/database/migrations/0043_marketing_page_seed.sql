-- Marketing CMS page seed (FE-VER-02 F-2).
--
-- GET /v1/ops/marketing/pages/{slug} already exists and passes its unit tests,
-- but live it answered 404 for home / harga / untuk-sekolah. Cause was data,
-- not routing: marketing_content only ever held the __global__ row, so the ops
-- list (kind = 'page') returned [] and every per-slug read threw notFound().
-- Nothing in the repo ever seeded the three public pages — the seed script
-- (scripts/seed-marketing-global.mjs) exists but is a manual, local-only step
-- that was never run against this database.
--
-- Rows land as DRAFT with draft_payload filled in and published_version NULL.
-- The authoring console can read, edit and publish them immediately; the public
-- marketing pages keep rendering their handcrafted JSX fallback until a
-- superadmin publishes, so this migration cannot change the live site.
--
-- Idempotent: an advisory lock serialises concurrent appliers and every insert
-- is guarded by WHERE NOT EXISTS, so re-running on a database that already has
-- the rows is a no-op and never clobbers edited content.
--
-- Forward fix: edit the pages through /ops/content.
-- Rollback: DELETE FROM marketing_content WHERE kind = 'page' AND slug IN
--   ('home','harga','untuk-sekolah');

BEGIN;
SELECT pg_advisory_xact_lock(430043);

INSERT INTO "marketing_content"
  (kind, slug, locale, current_version, published_version, draft_payload, revision, state, updated_by)
SELECT 'page', 'home', 'id-ID', 1, NULL, $seed${"schemaVersion":1,"blocks":[{"id":"hero-1","type":"hero","eyebrow":"lembar","heading":"Asesmen kurikulum yang rapi","body":"Buat, review, dan cetak asesmen dengan alur kerja yang jelas.","theme":"light","mediaAssetId":null,"ctas":[{"id":"hero-cta","label":"Coba sekarang","href":"/register","variant":"primary","placement":"hero","audience":"all","trackingKey":"hero_cta","enabled":true,"external":false,"accessibleLabel":"Coba sekarang"}],"items":[]}],"seo":{"title":"lembar — asesmen untuk guru","description":"Buat, review, dan cetak asesmen dengan alur kerja yang jelas.","imageAssetId":null,"noIndex":false}}$seed$::jsonb, 1, 'draft', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM "marketing_content"
  WHERE kind = 'page' AND slug = 'home' AND locale = 'id-ID'
);

INSERT INTO "marketing_content"
  (kind, slug, locale, current_version, published_version, draft_payload, revision, state, updated_by)
SELECT 'page', 'untuk-sekolah', 'id-ID', 1, NULL, $seed${"schemaVersion":1,"blocks":[{"id":"hero-1","type":"hero","eyebrow":"lembar","heading":"Workspace Organisasi untuk Institusi Sekolah","body":"Sentralisasi pembuatan soal dan manajemen akun guru dalam satu dasbor yang aman.","theme":"light","mediaAssetId":null,"ctas":[{"id":"hero-cta","label":"Coba sekarang","href":"/register","variant":"primary","placement":"hero","audience":"all","trackingKey":"hero_cta","enabled":true,"external":false,"accessibleLabel":"Coba sekarang"}],"items":[]}],"seo":{"title":"lembar untuk sekolah","description":"Sentralisasi pembuatan soal dan manajemen akun guru dalam satu dasbor yang aman.","imageAssetId":null,"noIndex":false}}$seed$::jsonb, 1, 'draft', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM "marketing_content"
  WHERE kind = 'page' AND slug = 'untuk-sekolah' AND locale = 'id-ID'
);

INSERT INTO "marketing_content"
  (kind, slug, locale, current_version, published_version, draft_payload, revision, state, updated_by)
SELECT 'page', 'harga', 'id-ID', 1, NULL, $seed${"schemaVersion":1,"blocks":[{"id":"hero-1","type":"hero","eyebrow":"lembar","heading":"Pilih paket yang sesuai untuk kebutuhan mengajar Anda.","body":"Temukan pilihan paket untuk kebutuhan guru dan sekolah.","theme":"light","mediaAssetId":null,"ctas":[{"id":"hero-cta","label":"Coba sekarang","href":"/register","variant":"primary","placement":"hero","audience":"all","trackingKey":"hero_cta","enabled":true,"external":false,"accessibleLabel":"Coba sekarang"}],"items":[]}],"seo":{"title":"Harga lembar — paket untuk guru dan sekolah","description":"Temukan pilihan paket untuk kebutuhan guru dan sekolah.","imageAssetId":null,"noIndex":false}}$seed$::jsonb, 1, 'draft', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM "marketing_content"
  WHERE kind = 'page' AND slug = 'harga' AND locale = 'id-ID'
);

COMMIT;
