-- Fix: search_learnings rank column type mismatch (REAL vs DOUBLE PRECISION)
-- The CASE expression with * 2.0 promotes to double precision, but the function
-- declares rank as REAL. Cast the result explicitly.

CREATE OR REPLACE FUNCTION search_learnings(
  query_text TEXT,
  agent_id_filter TEXT DEFAULT NULL,
  client_code_filter TEXT DEFAULT NULL,
  result_limit INTEGER DEFAULT 20
)
RETURNS TABLE(
  id TEXT,
  agent_id TEXT,
  category TEXT,
  content TEXT,
  confidence DOUBLE PRECISION,
  applied_count INTEGER,
  source_session_id TEXT,
  client_code TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  rank REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    l.id, l.agent_id, l.category, l.content, l.confidence, l.applied_count,
    l.source_session_id, l.client_code, l.created_at, l.updated_at,
    (CASE
      WHEN client_code_filter IS NOT NULL AND l.client_code = client_code_filter
      THEN TS_RANK_CD(l.search_vector, PLAINTO_TSQUERY('english', query_text)) * 2.0
      ELSE TS_RANK_CD(l.search_vector, PLAINTO_TSQUERY('english', query_text))::double precision
    END)::REAL AS rank
  FROM learnings l
  WHERE l.search_vector @@ PLAINTO_TSQUERY('english', query_text)
    AND (agent_id_filter IS NULL OR l.agent_id = agent_id_filter)
  ORDER BY rank DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql STABLE;
