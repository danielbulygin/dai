-- Update sync-fireflies cron from 6h to 3h (safety net for webhook)
DO $$
BEGIN
  PERFORM cron.unschedule('sync-fireflies');
EXCEPTION WHEN OTHERS THEN
  NULL;
END
$$;

SELECT cron.schedule(
  'sync-fireflies',
  '0 */3 * * *',
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
