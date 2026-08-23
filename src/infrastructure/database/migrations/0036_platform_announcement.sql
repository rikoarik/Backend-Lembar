-- Singleton banner managed by superadmin and read by public marketing pages.
-- Forward fix: update the singleton row or add a follow-up migration.
-- Rollback: DROP TABLE IF EXISTS platform_announcement;

CREATE TABLE IF NOT EXISTS platform_announcement (
  id text PRIMARY KEY DEFAULT 'global',
  enabled boolean NOT NULL DEFAULT true,
  label text NOT NULL DEFAULT 'Beta',
  message text NOT NULL,
  cta_label text,
  cta_href text,
  revision integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES jwt_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_announcement_singleton CHECK (id = 'global'),
  CONSTRAINT platform_announcement_label_length CHECK (char_length(label) BETWEEN 1 AND 40),
  CONSTRAINT platform_announcement_message_length CHECK (char_length(message) BETWEEN 1 AND 240),
  CONSTRAINT platform_announcement_cta_label_length CHECK (
    cta_label IS NULL OR char_length(cta_label) BETWEEN 1 AND 80
  ),
  CONSTRAINT platform_announcement_cta_href_length CHECK (
    cta_href IS NULL OR char_length(cta_href) BETWEEN 1 AND 500
  ),
  CONSTRAINT platform_announcement_revision_positive CHECK (revision >= 1),
  CONSTRAINT platform_announcement_cta_pair CHECK (
    (cta_label IS NULL AND cta_href IS NULL) OR
    (cta_label IS NOT NULL AND cta_href IS NOT NULL)
  )
);

INSERT INTO platform_announcement (id, enabled, label, message, cta_label, cta_href)
VALUES (
  'global',
  true,
  'Beta',
  'Lembar sedang dalam tahap beta dan terus disempurnakan bersama guru Indonesia.',
  'Mulai mencoba',
  '/daftar'
)
ON CONFLICT (id) DO NOTHING;
