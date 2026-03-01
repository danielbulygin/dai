-- Weekly confidence decay for Jasmin preferences.
-- Multiplies confidence by 0.95 for preferences not updated in 7+ days.
-- Floor at 0.1 to prevent full erasure.

CREATE OR REPLACE FUNCTION decay_jasmin_confidence()
RETURNS INTEGER AS $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE learnings
  SET confidence = GREATEST(confidence * 0.95, 0.1)
  WHERE agent_id = 'jasmin'
    AND category LIKE 'preference_%'
    AND category != 'preference_summary'
    AND updated_at < NOW() - INTERVAL '7 days';

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$ LANGUAGE plpgsql;
