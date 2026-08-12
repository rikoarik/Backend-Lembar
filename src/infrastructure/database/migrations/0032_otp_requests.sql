-- OTP requests for WhatsApp-based authentication.
-- Rollback: DROP TABLE otp_requests;

CREATE TABLE IF NOT EXISTS otp_requests (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text        NOT NULL,
  code_hash   text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Drives both rate-limit query (count by phone in window) and verify lookup.
CREATE INDEX IF NOT EXISTS idx_otp_requests_phone_expires
  ON otp_requests (phone, expires_at);
