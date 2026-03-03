-- Fix briefings type constraint to include 'weekly' type.
-- Weekly briefings silently failed to persist every Monday because the CHECK
-- constraint only allowed ('morning', 'eod', 'on_demand').

ALTER TABLE briefings DROP CONSTRAINT IF EXISTS briefings_type_check;
ALTER TABLE briefings ADD CONSTRAINT briefings_type_check
  CHECK (type IN ('morning', 'eod', 'weekly', 'on_demand'));
