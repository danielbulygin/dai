-- Meeting Intelligence Pipeline: call_extractions table + pipeline_status on meetings
--
-- call_extractions stores the classified + extracted data for each meeting.
-- meetings.pipeline_status tracks where each meeting is in the pipeline.

-- 1. Add pipeline_status to existing meetings table
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS pipeline_status TEXT
  CHECK (pipeline_status IN ('classified', 'extracted', 'routed', 'deep_extracted'));

-- NULL = unprocessed (default)
CREATE INDEX IF NOT EXISTS idx_meetings_pipeline_status
  ON meetings (pipeline_status)
  WHERE pipeline_status IS NULL;

-- 2. Create call_extractions table
CREATE TABLE IF NOT EXISTS call_extractions (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  meeting_id    TEXT NOT NULL UNIQUE REFERENCES meetings(id) ON DELETE CASCADE,
  client_code   TEXT,
  meeting_type  TEXT,
  is_external   BOOLEAN DEFAULT false,
  classification JSONB DEFAULT '{}'::jsonb,
  extraction    JSONB DEFAULT '{}'::jsonb,
  routing_signals JSONB DEFAULT '{}'::jsonb,
  deep_extracted BOOLEAN DEFAULT false,
  model_used    TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_extractions_client_code
  ON call_extractions (client_code);

CREATE INDEX IF NOT EXISTS idx_call_extractions_meeting_id
  ON call_extractions (meeting_id);
