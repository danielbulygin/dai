-- monitoring_insights: channel monitoring analysis results persisted from DAI
CREATE TABLE monitoring_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_count INTEGER NOT NULL,
  blockers JSONB NOT NULL DEFAULT '[]',
  urgent JSONB NOT NULL DEFAULT '[]',
  notable JSONB NOT NULL DEFAULT '[]',
  suggested_actions JSONB NOT NULL DEFAULT '[]',
  has_high_priority BOOLEAN NOT NULL DEFAULT FALSE,
  raw_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_monitoring_insights_analyzed ON monitoring_insights(analyzed_at DESC);
CREATE INDEX idx_monitoring_insights_high_priority ON monitoring_insights(has_high_priority) WHERE has_high_priority = TRUE;
