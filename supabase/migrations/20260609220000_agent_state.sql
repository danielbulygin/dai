-- Generic key-value state for agents and scheduled jobs.
-- First consumer: the ready-to-upload digest, which diffs against its own
-- last post so it can report deltas instead of re-listing the same backlog
-- verbatim twice a day (JVAx3864 was re-listed 20+ times over 3 weeks).
-- Applied to the DAI Supabase project on 2026-06-09 via the Management API.
CREATE TABLE IF NOT EXISTS agent_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
