-- Meeting deduplication: When multiple Fireflies bots record the same call,
-- keep Daniel's copy as canonical and delete the rest.
-- organizer_email = whose Fireflies bot recorded the transcript (i.e. the source).

-- ==========================================================================
-- dedup_meetings(): Finds duplicate meetings (same title, date within 5 min),
-- keeps Daniel's copy, deletes the rest. If Daniel wasn't in the meeting,
-- keeps the copy with the lowest ID.
-- meeting_sentences cascade-deletes automatically.
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
    WHERE better.title = m.title
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

-- ==========================================================================
-- Add index to speed up dedup lookups (title + date)
-- ==========================================================================
CREATE INDEX IF NOT EXISTS idx_meetings_title_date ON meetings(title, date);

-- ==========================================================================
-- Run dedup on existing data
-- ==========================================================================
SELECT * FROM dedup_meetings();
