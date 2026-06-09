-- Allow 'auto_approved' status (policy 2026-06-09: high-confidence durable
-- insights auto-approve into methodology_knowledge; the review queue had been
-- dead since Mar 4). Applied to the DAI Supabase project 2026-06-10 via the
-- Management API.
ALTER TABLE pending_insights DROP CONSTRAINT pending_insights_status_check;
ALTER TABLE pending_insights ADD CONSTRAINT pending_insights_status_check
  CHECK (status = ANY (ARRAY['pending'::text,'approved'::text,'rejected'::text,'auto_saved'::text,'auto_approved'::text]));
