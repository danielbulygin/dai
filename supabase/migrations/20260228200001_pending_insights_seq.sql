-- Add seq column to pending_insights (missed in initial migration)
ALTER TABLE pending_insights ADD COLUMN IF NOT EXISTS seq INTEGER;
