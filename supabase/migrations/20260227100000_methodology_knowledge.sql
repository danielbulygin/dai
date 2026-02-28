-- Methodology knowledge extracted from meeting transcripts (Phase 3).
-- Single table with type discriminator: rule, insight, decision, creative_pattern, methodology.

CREATE TABLE IF NOT EXISTS methodology_knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('rule', 'insight', 'decision', 'creative_pattern', 'methodology')),
  title TEXT NOT NULL,
  body JSONB NOT NULL DEFAULT '{}',
  account_code TEXT,             -- NULL = global
  category TEXT,                 -- insight subcategory or decision type
  confidence TEXT CHECK (confidence IN ('high', 'medium')),
  source_meeting TEXT,
  source_date DATE,
  extraction_run TEXT NOT NULL,  -- identifies which run produced this row (for idempotent re-loads)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_mk_type ON methodology_knowledge (type);
CREATE INDEX IF NOT EXISTS idx_mk_account_code ON methodology_knowledge (account_code) WHERE account_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mk_category ON methodology_knowledge (category) WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mk_extraction_run ON methodology_knowledge (extraction_run);

-- Full-text search: title weight A, body text weight B
DO $$ BEGIN
  ALTER TABLE methodology_knowledge ADD COLUMN fts TSVECTOR
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(body::text, '')), 'B')
    ) STORED;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_mk_fts ON methodology_knowledge USING GIN (fts);

-- RPC function: search methodology knowledge with optional filters
CREATE OR REPLACE FUNCTION search_methodology(
  search_query TEXT DEFAULT NULL,
  filter_type TEXT DEFAULT NULL,
  filter_account TEXT DEFAULT NULL,
  filter_category TEXT DEFAULT NULL,
  result_limit INT DEFAULT 20
)
RETURNS TABLE (
  id UUID,
  type TEXT,
  title TEXT,
  body JSONB,
  account_code TEXT,
  category TEXT,
  confidence TEXT,
  source_meeting TEXT,
  source_date DATE,
  rank REAL
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    mk.id,
    mk.type,
    mk.title,
    mk.body,
    mk.account_code,
    mk.category,
    mk.confidence,
    mk.source_meeting,
    mk.source_date,
    CASE
      WHEN search_query IS NOT NULL AND search_query <> '' THEN
        ts_rank(mk.fts, websearch_to_tsquery('english', search_query))
        * CASE WHEN filter_account IS NOT NULL AND mk.account_code = filter_account THEN 2.0::real ELSE 1.0::real END
      ELSE 1.0::real
    END AS rank
  FROM methodology_knowledge mk
  WHERE
    (filter_type IS NULL OR mk.type = filter_type)
    AND (filter_account IS NULL OR mk.account_code = filter_account OR mk.account_code IS NULL)
    AND (filter_category IS NULL OR mk.category = filter_category)
    AND (search_query IS NULL OR search_query = '' OR mk.fts @@ websearch_to_tsquery('english', search_query))
  ORDER BY rank DESC, mk.created_at DESC
  LIMIT result_limit;
END;
$$;
