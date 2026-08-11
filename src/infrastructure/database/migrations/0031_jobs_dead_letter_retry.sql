-- P1 jobs/DLQ hardening: preserve dead-letter jobs as a distinct retryable terminal state.
-- Rollback: ALTER TABLE spike_jobs DROP CONSTRAINT spike_jobs_status_check;
--           ALTER TABLE spike_jobs ADD CONSTRAINT spike_jobs_status_check
--             CHECK (status IN ('created','queued','running','retry_wait','succeeded','partially_succeeded','failed','cancelled'));

ALTER TABLE spike_jobs DROP CONSTRAINT IF EXISTS spike_jobs_status_check;
ALTER TABLE spike_jobs
  ADD CONSTRAINT spike_jobs_status_check
  CHECK (status IN (
    'created', 'queued', 'running', 'retry_wait', 'succeeded',
    'partially_succeeded', 'failed', 'dead_letter', 'cancelled'
  ));

CREATE INDEX IF NOT EXISTS idx_spike_jobs_retryable
  ON spike_jobs (status, created_at)
  WHERE status IN ('failed', 'dead_letter');
