-- Client agents configuration table
-- Maps Slack channels to client-scoped Ada instances
-- Run against DAI Supabase (fgwzscafqolpjtmcnxhn)

CREATE TABLE IF NOT EXISTS client_agents (
  id TEXT PRIMARY KEY,
  client_code TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT 'Ada',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_agents_channel
  ON client_agents(channel_id) WHERE is_active;
