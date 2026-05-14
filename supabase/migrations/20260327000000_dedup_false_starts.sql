-- Clean up false-start recordings: short meetings (<8 min) where a longer
-- meeting with the same title exists on the same calendar day.
-- meeting_sentences cascade-deletes automatically.

CREATE OR REPLACE FUNCTION cleanup_false_starts(
  min_duration_minutes INT DEFAULT 8
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

  DELETE FROM meetings short
  WHERE short.duration IS NOT NULL
    AND short.duration < min_duration_minutes
    AND short.date IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM meetings longer
      WHERE longer.title = short.title
        AND longer.id != short.id
        AND longer.date IS NOT NULL
        AND longer.duration IS NOT NULL
        AND longer.duration >= min_duration_minutes
        -- same calendar day (UTC)
        AND longer.date::date = short.date::date
    );

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN QUERY SELECT v_deleted, v_total - v_deleted;
END;
$$ LANGUAGE plpgsql;

-- Run on existing data
SELECT * FROM cleanup_false_starts();
