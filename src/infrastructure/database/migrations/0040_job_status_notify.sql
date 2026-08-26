-- Push job changes to SSE consumers without HTTP/DB polling.
CREATE OR REPLACE FUNCTION notify_lembar_job_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('lembar_job_' || replace(NEW.id::text, '-', ''), NEW.status::text);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS spike_jobs_status_notify ON spike_jobs;
--> statement-breakpoint
CREATE TRIGGER spike_jobs_status_notify
AFTER INSERT OR UPDATE OF status, payload, last_error ON spike_jobs
FOR EACH ROW EXECUTE FUNCTION notify_lembar_job_status();
