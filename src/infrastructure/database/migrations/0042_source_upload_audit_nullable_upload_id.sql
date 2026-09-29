-- BUG-18: an intake that fails before an upload row exists (unsupported content
-- type) must still be audited. The service previously wrote the all-zero uuid
-- sentinel here, which violated source_upload_audit_upload_id_source_uploads_id_fk
-- and turned the intended 415 into a 500. The column becomes nullable so the
-- failed attempt is recorded against the workspace alone.
ALTER TABLE "source_upload_audit" ALTER COLUMN "upload_id" DROP NOT NULL;
