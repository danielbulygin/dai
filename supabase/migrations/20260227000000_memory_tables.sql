-- Migration: Move DAI memory tables from SQLite to Supabase (PostgreSQL)
-- 9 tables + FTS infrastructure (tsvector/GIN) + RPC functions

-- ==========================================================================
-- 1. TABLES
-- ==========================================================================

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT,
  user_id TEXT NOT NULL,
  claude_session_id TEXT,
  summary TEXT,
  total_cost DOUBLE PRECISION DEFAULT 0,
  total_turns INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  importance INTEGER DEFAULT 5,
  tags TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  search_vector TSVECTOR
);

CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS learnings (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence DOUBLE PRECISION DEFAULT 0.5,
  applied_count INTEGER DEFAULT 0,
  source_session_id TEXT,
  client_code TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  search_vector TSVECTOR,
  score DOUBLE PRECISION GENERATED ALWAYS AS (confidence * applied_count) STORED
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  sentiment TEXT NOT NULL,
  content TEXT,
  message_ts TEXT,
  processed INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  account_code TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  target TEXT NOT NULL,
  rationale TEXT NOT NULL,
  metrics_snapshot TEXT,
  outcome TEXT,
  outcome_metrics TEXT,
  evaluated_at TIMESTAMPTZ,
  session_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transcript_ingestion_log (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL UNIQUE,
  meeting_title TEXT,
  pattern_id TEXT,
  insights_extracted INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_monitor (
  id BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  user_id TEXT NOT NULL,
  user_name TEXT,
  message_ts TEXT NOT NULL UNIQUE,
  thread_ts TEXT,
  text TEXT NOT NULL,
  matched_keywords TEXT,
  priority TEXT DEFAULT 'normal',
  analyzed INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================================================
-- 2. INDEXES
-- ==========================================================================

CREATE INDEX IF NOT EXISTS idx_sessions_channel_thread ON sessions(channel_id, thread_ts);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_learnings_agent ON learnings(agent_id);
CREATE INDEX IF NOT EXISTS idx_learnings_client_code ON learnings(client_code);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback(session_id);
CREATE INDEX IF NOT EXISTS idx_feedback_processed ON feedback(processed);
CREATE INDEX IF NOT EXISTS idx_decisions_agent ON decisions(agent_id);
CREATE INDEX IF NOT EXISTS idx_decisions_pending ON decisions(outcome) WHERE outcome IS NULL;
CREATE INDEX IF NOT EXISTS idx_transcript_ingestion_meeting ON transcript_ingestion_log(meeting_id);
CREATE INDEX IF NOT EXISTS idx_channel_monitor_analyzed ON channel_monitor(analyzed);
CREATE INDEX IF NOT EXISTS idx_channel_monitor_created ON channel_monitor(created_at);

-- GIN indexes for full-text search
CREATE INDEX IF NOT EXISTS idx_observations_search_vector ON observations USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_learnings_search_vector ON learnings USING GIN(search_vector);

-- ==========================================================================
-- 3. TRIGGER FUNCTIONS
-- ==========================================================================

-- Auto-update search_vector on observations
CREATE OR REPLACE FUNCTION observations_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector :=
    SETWEIGHT(TO_TSVECTOR('english', COALESCE(NEW.input_summary, '')), 'A') ||
    SETWEIGHT(TO_TSVECTOR('english', COALESCE(NEW.output_summary, '')), 'B') ||
    SETWEIGHT(TO_TSVECTOR('english', COALESCE(NEW.tags, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER observations_search_vector_trigger
  BEFORE INSERT OR UPDATE ON observations
  FOR EACH ROW
  EXECUTE FUNCTION observations_search_vector_update();

-- Auto-update search_vector on learnings
CREATE OR REPLACE FUNCTION learnings_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector :=
    SETWEIGHT(TO_TSVECTOR('english', COALESCE(NEW.content, '')), 'A') ||
    SETWEIGHT(TO_TSVECTOR('english', COALESCE(NEW.category, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER learnings_search_vector_trigger
  BEFORE INSERT OR UPDATE ON learnings
  FOR EACH ROW
  EXECUTE FUNCTION learnings_search_vector_update();

-- Auto-update updated_at on sessions
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER sessions_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER learnings_updated_at
  BEFORE UPDATE ON learnings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ==========================================================================
-- 4. RPC FUNCTIONS (replacing FTS5 MATCH queries)
-- ==========================================================================

-- Search observations by full-text query
CREATE OR REPLACE FUNCTION search_observations(
  query_text TEXT,
  agent_id_filter TEXT DEFAULT NULL,
  result_limit INTEGER DEFAULT 10
)
RETURNS TABLE(
  id TEXT,
  session_id TEXT,
  tool_name TEXT,
  input_summary TEXT,
  output_summary TEXT,
  importance INTEGER,
  tags TEXT,
  created_at TIMESTAMPTZ,
  rank REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    o.id, o.session_id, o.tool_name, o.input_summary, o.output_summary,
    o.importance, o.tags, o.created_at,
    TS_RANK_CD(o.search_vector, PLAINTO_TSQUERY('english', query_text)) AS rank
  FROM observations o
  LEFT JOIN sessions s ON o.session_id = s.id
  WHERE o.search_vector @@ PLAINTO_TSQUERY('english', query_text)
    AND (agent_id_filter IS NULL OR s.agent_id = agent_id_filter)
  ORDER BY rank DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql STABLE;

-- Search learnings by full-text query with optional client filtering
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
    -- Boost client-specific results by 2x when client_code_filter is provided
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

-- Find similar learnings for deduplication
CREATE OR REPLACE FUNCTION find_similar_learnings(
  query_text TEXT,
  agent_id_filter TEXT,
  category_filter TEXT,
  result_limit INTEGER DEFAULT 5
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
    TS_RANK_CD(l.search_vector, PLAINTO_TSQUERY('english', query_text)) AS rank
  FROM learnings l
  WHERE l.search_vector @@ PLAINTO_TSQUERY('english', query_text)
    AND l.agent_id = agent_id_filter
    AND l.category = category_filter
  ORDER BY rank DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql STABLE;

-- Atomic increment of applied_count
CREATE OR REPLACE FUNCTION increment_applied(learning_id TEXT)
RETURNS VOID AS $$
BEGIN
  UPDATE learnings
  SET applied_count = applied_count + 1
  WHERE id = learning_id;
END;
$$ LANGUAGE plpgsql;
