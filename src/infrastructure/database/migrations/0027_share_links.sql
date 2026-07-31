-- 0027_share_links — persistent share link storage (replaces InMemoryShareLinkStore)
CREATE TABLE IF NOT EXISTS share_links (
  id            uuid        PRIMARY KEY,
  workspace_id  text        NOT NULL,
  assessment_id text        NOT NULL,
  token         text        NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS share_links_workspace_assessment
  ON share_links (workspace_id, assessment_id);
CREATE INDEX IF NOT EXISTS share_links_token
  ON share_links (token);
