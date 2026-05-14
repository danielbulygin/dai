-- Improve meeting deduplication to handle title variations.
-- Fireflies records the same meeting from multiple participants' bots.
-- Google Meet prefixes some with "Meet – " / "Meet - " / "Meet — ".
-- This migration normalizes titles before comparison.

-- ==========================================================================
-- Helper: strips common prefixes and normalizes whitespace
-- ==========================================================================
CREATE OR REPLACE FUNCTION normalize_meeting_title(raw TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN TRIM(
    regexp_replace(
      COALESCE(raw, ''),
      '^Meet\s*[\-–—]\s*',  -- "Meet – ", "Meet - ", "Meet — "
      '',
      'i'
    )
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ==========================================================================
-- Updated dedup: compares normalized titles instead of exact match
-- ==========================================================================
CREATE OR REPLACE FUNCTION dedup_meetings(
  canonical_email TEXT DEFAULT 'daniel.bulygin@gmail.com'
)
RETURNS TABLE (
  deleted_count BIGINT,
  kept_count BIGINT
) AS $$
DECLARE
  v_deleted BIGINT;
  v_total BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_total FROM meetings;

  -- Delete meeting m if a strictly "better" duplicate exists.
  -- "Better" = canonical email wins; if tied, lower ID wins.
  DELETE FROM meetings m
  WHERE EXISTS (
    SELECT 1 FROM meetings better
    WHERE normalize_meeting_title(better.title) = normalize_meeting_title(m.title)
      AND better.id != m.id
      AND m.date IS NOT NULL AND better.date IS NOT NULL
      AND ABS(EXTRACT(EPOCH FROM (better.date - m.date))) <= 600
      AND (
        -- better is canonical, m is not
        (better.organizer_email = canonical_email AND m.organizer_email != canonical_email)
        OR
        -- same canonical status → keep lower ID
        (
          (better.organizer_email = canonical_email) = (m.organizer_email = canonical_email)
          AND better.id < m.id
        )
      )
  );

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN QUERY SELECT v_deleted, v_total - v_deleted;
END;
$$ LANGUAGE plpgsql;

-- Allow 'deduped' as a pipeline_status value
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_pipeline_status_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_pipeline_status_check
  CHECK (pipeline_status IN ('classified', 'extracted', 'routed', 'deep_extracted', 'deduped'));

-- Run dedup on existing data to clean up any missed duplicates
SELECT * FROM dedup_meetings();
