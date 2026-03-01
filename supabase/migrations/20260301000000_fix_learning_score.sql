-- Fix: score was confidence * applied_count, so score = 0 when applied_count = 0.
-- New formula: confidence * (applied_count + 1), so score > 0 for all learnings.

ALTER TABLE learnings DROP COLUMN score;
ALTER TABLE learnings ADD COLUMN score DOUBLE PRECISION GENERATED ALWAYS AS (confidence * (applied_count + 1)) STORED;
