-- piper_actions: audit log of every dai-agent tool call.
-- Logged by tool-registry executeTool() middleware. Per Piper EVOLUTION.md Phase 1.5.
-- Not Piper-specific in scope (every dai agent writes here), but Piper owns the
-- design and is the first agent to consume it via inspect_piper_actions.

CREATE TABLE IF NOT EXISTS piper_actions (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  agent_id TEXT NOT NULL,
  session_id TEXT,
  channel_id TEXT,
  user_id TEXT,
  action_type TEXT NOT NULL DEFAULT 'tool_call',
  -- action_type values: tool_call | write | dm | digest_posted
  tool_name TEXT,
  initiator TEXT,
  -- initiator is a Slack user id or 'cron'
  params JSONB,
  result_summary TEXT,
  target_system TEXT,
  -- target_system values: notion | meta | slack | frameio | supabase | drive
  target_id TEXT,
  before_state JSONB,
  after_state JSONB,
  reverse_action JSONB,
  status TEXT NOT NULL DEFAULT 'success',
  -- status values: success | failed | partial
  duration_ms INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS piper_actions_timestamp_idx
  ON piper_actions (timestamp DESC);

CREATE INDEX IF NOT EXISTS piper_actions_agent_timestamp_idx
  ON piper_actions (agent_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS piper_actions_tool_timestamp_idx
  ON piper_actions (tool_name, timestamp DESC);

CREATE INDEX IF NOT EXISTS piper_actions_status_idx
  ON piper_actions (status) WHERE status != 'success';

COMMENT ON TABLE piper_actions IS
  'Audit log of every dai-agent tool call. Written by tool-registry executeTool() middleware. Per Piper EVOLUTION.md Phase 1.5. Default retention 1 year (no automated TTL yet — purge job comes later).';
