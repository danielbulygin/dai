-- Fix search_meetings: use partial case-insensitive speaker matching
-- Before: speaker_filter = ANY(m.speakers) — requires exact match
-- After: ILIKE partial match so "Kousha" finds "Kousha Torabi"

CREATE OR REPLACE FUNCTION search_meetings(
  search_query TEXT,
  from_date TIMESTAMPTZ DEFAULT NULL,
  to_date TIMESTAMPTZ DEFAULT NULL,
  speaker_filter TEXT DEFAULT NULL,
  result_limit INT DEFAULT 20
)
RETURNS TABLE (
  id TEXT,
  title TEXT,
  date TIMESTAMPTZ,
  duration REAL,
  organizer_email TEXT,
  speakers TEXT[],
  short_summary TEXT,
  keywords TEXT[],
  action_items TEXT,
  overview TEXT,
  rank REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.title,
    m.date,
    m.duration,
    m.organizer_email,
    m.speakers,
    m.short_summary,
    m.keywords,
    m.action_items,
    m.overview,
    (ts_rank(m.fts_summary, q) * 2 + ts_rank(m.fts_transcript, q))::REAL AS rank
  FROM meetings m, plainto_tsquery('simple', search_query) q
  WHERE
    (m.fts_summary @@ q OR m.fts_transcript @@ q)
    AND (from_date IS NULL OR m.date >= from_date)
    AND (to_date IS NULL OR m.date <= to_date)
    AND (speaker_filter IS NULL OR EXISTS (
      SELECT 1 FROM unnest(m.speakers) AS s WHERE s ILIKE '%' || speaker_filter || '%'
    ))
  ORDER BY rank DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql;
