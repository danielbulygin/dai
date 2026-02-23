-- DAI Supabase Schema: Fireflies Meeting Transcripts
-- Run this in the Supabase SQL Editor after creating the project.

-- ==========================================================================
-- meetings: one row per Fireflies meeting
-- ==========================================================================
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,                  -- Fireflies meeting ID
  title TEXT,
  date TIMESTAMPTZ,
  duration REAL,                        -- seconds
  organizer_email TEXT,
  speakers TEXT[],
  participant_emails TEXT[],
  short_summary TEXT,
  keywords TEXT[],
  action_items TEXT,
  overview TEXT,
  notes TEXT,
  gist TEXT,
  full_transcript TEXT,                 -- concatenated "Speaker: text\n"
  -- Weighted full-text search (simple config = bilingual-safe, no stemming)
  fts_summary TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(short_summary, '') || ' ' || coalesce(action_items, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(overview, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(notes, '')), 'D')
  ) STORED,
  fts_transcript TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(full_transcript, ''))
  ) STORED,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================================================
-- meeting_sentences: sentence-level transcript data
-- ==========================================================================
CREATE TABLE meeting_sentences (
  id BIGSERIAL PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  sentence_index INT NOT NULL,
  speaker_name TEXT,
  text TEXT,
  raw_text TEXT,
  start_time REAL,
  end_time REAL,
  UNIQUE (meeting_id, sentence_index)
);

-- ==========================================================================
-- sync_state: singleton tracking sync progress
-- ==========================================================================
CREATE TABLE sync_state (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_synced_at TIMESTAMPTZ,
  last_sync_run TIMESTAMPTZ,
  total_synced INT DEFAULT 0,
  last_error TEXT
);

INSERT INTO sync_state (id) VALUES (1);

-- ==========================================================================
-- Indexes
-- ==========================================================================
CREATE INDEX idx_meetings_date ON meetings(date DESC);
CREATE INDEX idx_meetings_fts_summary ON meetings USING GIN(fts_summary);
CREATE INDEX idx_meetings_fts_transcript ON meetings USING GIN(fts_transcript);
CREATE INDEX idx_meetings_speakers ON meetings USING GIN(speakers);
CREATE INDEX idx_meetings_keywords ON meetings USING GIN(keywords);
CREATE INDEX idx_sentences_meeting_id ON meeting_sentences(meeting_id);
CREATE INDEX idx_sentences_speaker ON meeting_sentences(speaker_name);

-- ==========================================================================
-- search_meetings RPC: ranked search across summaries + transcripts
-- ==========================================================================
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
    AND (speaker_filter IS NULL OR speaker_filter = ANY(m.speakers))
  ORDER BY rank DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql;
