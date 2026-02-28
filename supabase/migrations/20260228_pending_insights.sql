-- Migration: pending_insights table for Nina/Daniel call monitoring
-- Stores extracted methodology insights awaiting Daniel's Slack approval

CREATE TABLE IF NOT EXISTS pending_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id TEXT NOT NULL,
  meeting_title TEXT,
  meeting_date DATE,
  type TEXT NOT NULL CHECK (type IN ('rule', 'insight', 'decision', 'creative_pattern', 'methodology')),
  title TEXT NOT NULL,
  body JSONB NOT NULL DEFAULT '{}',
  account_code TEXT,
  category TEXT,
  confidence TEXT CHECK (confidence IN ('high', 'medium')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  slack_message_ts TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_insights_status ON pending_insights(status);
CREATE INDEX IF NOT EXISTS idx_pending_insights_meeting ON pending_insights(meeting_id);
