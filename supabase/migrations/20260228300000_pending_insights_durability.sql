-- Add durability classification to pending_insights
-- "durable" = permanent methodology, requires approval
-- "situational" = time-bound observation, auto-saved to learnings

ALTER TABLE pending_insights
  ADD COLUMN IF NOT EXISTS durability TEXT DEFAULT 'durable'
  CHECK (durability IN ('durable', 'situational'));

-- Expand status enum to include 'auto_saved' for situational insights
ALTER TABLE pending_insights DROP CONSTRAINT IF EXISTS pending_insights_status_check;
ALTER TABLE pending_insights ADD CONSTRAINT pending_insights_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'auto_saved'));
