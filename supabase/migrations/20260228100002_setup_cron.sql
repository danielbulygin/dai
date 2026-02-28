-- Enable pg_cron and pg_net
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Schedule sync-fireflies every 6 hours
-- First try to unschedule if exists (ignore error if doesn't exist)
DO $$
BEGIN
  PERFORM cron.unschedule('sync-fireflies');
EXCEPTION WHEN OTHERS THEN
  NULL; -- ignore if job doesn't exist
END
$$;

SELECT cron.schedule(
  'sync-fireflies',
  '0 */6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://fgwzscafqolpjtmcnxhn.supabase.co/functions/v1/sync-fireflies',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZnd3pzY2FmcW9scGp0bWNueGhuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTg4MzUzMiwiZXhwIjoyMDg3NDU5NTMyfQ.Z8Jg0Isvl-hhz2GhADqVKCA_qRO5Mdc_0w2-ocLEL90',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
