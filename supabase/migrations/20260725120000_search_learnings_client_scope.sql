-- Cross-tenant fix: search_learnings had NO client_code row filter.
--
-- `client_code_filter` was only ever read inside the rank CASE (a 2x boost), so
-- the WHERE clause filtered on search_vector + agent_id_filter alone. A
-- client-scoped customer chat calling `search_memories` (which passed
-- agent_id_filter = NULL) therefore got EVERY tenant's learnings back. dai runs
-- on the Supabase service-role key throughout, so RLS is bypassed and there is
-- no DB backstop — this filter is the second half of the boundary (the first is
-- the forced scope in tool-registry.executeTool / the search_memories executor).
--
-- New argument: client_code_strict.
--   FALSE (the default) reproduces today's behaviour EXACTLY — client_code_filter
--   stays a pure rank boost. Every existing 4-arg caller (recall() in
--   src/memory/search.ts, the pipeline context builder, the transcript ingestor)
--   is untouched, so the internal agency agent keeps its cross-client search.
--   TRUE turns the boost into a hard row filter and is passed ONLY by
--   client-scoped (customer) runs.
--
-- Fail-closed on purpose: under strict, a NULL client_code_filter matches no row
-- (`l.client_code = NULL` is NULL, not TRUE). Strict means "you must name the
-- client", never "filter is optional".
--
-- CREATE OR REPLACE cannot add a parameter, so the old 4-arg signature is
-- dropped first. The defaulted 5th argument keeps every existing 4-arg call site
-- resolving to this function unchanged (and avoids an ambiguous overload).

DROP FUNCTION IF EXISTS search_learnings(TEXT, TEXT, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION search_learnings(
  query_text TEXT,
  agent_id_filter TEXT DEFAULT NULL,
  client_code_filter TEXT DEFAULT NULL,
  result_limit INTEGER DEFAULT 20,
  client_code_strict BOOLEAN DEFAULT FALSE
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
    -- Boost client-specific results by 2x when client_code_filter is provided
    (CASE
      WHEN client_code_filter IS NOT NULL AND l.client_code = client_code_filter
      THEN TS_RANK_CD(l.search_vector, PLAINTO_TSQUERY('english', query_text)) * 2.0
      ELSE TS_RANK_CD(l.search_vector, PLAINTO_TSQUERY('english', query_text))::double precision
    END)::REAL AS rank
  FROM learnings l
  WHERE l.search_vector @@ PLAINTO_TSQUERY('english', query_text)
    AND (agent_id_filter IS NULL OR l.agent_id = agent_id_filter)
    -- The tenant boundary. Off by default (boost-only), hard filter when strict.
    AND (
      NOT COALESCE(client_code_strict, FALSE)
      OR l.client_code = client_code_filter
    )
  ORDER BY rank DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql STABLE;
