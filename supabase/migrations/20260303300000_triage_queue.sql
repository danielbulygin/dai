-- Triage queue: real-time notification triage for Jasmin
-- Tracks items from email, Slack DMs, and channels that need Daniel's attention

CREATE TABLE triage_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('email', 'slack_dm', 'slack_channel', 'calendar')),
  source_id TEXT NOT NULL UNIQUE,
  priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  priority_num SMALLINT NOT NULL DEFAULT 3,
  title TEXT NOT NULL,
  preview TEXT,
  reason TEXT,
  suggested_action TEXT,
  metadata JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'notified', 'acknowledged', 'snoozed', 'resolved', 'expired')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at TIMESTAMPTZ,
  snoozed_until TIMESTAMPTZ,
  notification_ts TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_triage_queue_status ON triage_queue (status);
CREATE INDEX idx_triage_queue_priority ON triage_queue (priority_num, detected_at);
CREATE INDEX idx_triage_queue_source ON triage_queue (source, status);
CREATE INDEX idx_triage_queue_snoozed ON triage_queue (snoozed_until) WHERE status = 'snoozed';

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_triage_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_triage_updated_at
  BEFORE UPDATE ON triage_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_triage_updated_at();

-- Upsert guard: priority only escalates (lower priority_num = more urgent)
CREATE OR REPLACE FUNCTION triage_upsert_guard()
RETURNS TRIGGER AS $$
BEGIN
  -- If item already exists and is resolved/expired, allow full update (re-detection)
  IF OLD.status IN ('resolved', 'expired') THEN
    RETURN NEW;
  END IF;
  -- Don't de-escalate priority
  IF NEW.priority_num > OLD.priority_num THEN
    NEW.priority_num = OLD.priority_num;
    NEW.priority = OLD.priority;
  END IF;
  -- Don't reset status from notified/acknowledged back to pending
  IF OLD.status IN ('notified', 'acknowledged') AND NEW.status = 'pending' THEN
    NEW.status = OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_triage_upsert_guard
  BEFORE UPDATE ON triage_queue
  FOR EACH ROW
  EXECUTE FUNCTION triage_upsert_guard();

-- Scan state: watermarks for each scanner
CREATE TABLE triage_scan_state (
  source_id TEXT PRIMARY KEY,
  watermark TEXT,
  last_scan_at TIMESTAMPTZ,
  extra JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- RPC: get pending triage items by priority
CREATE OR REPLACE FUNCTION get_pending_triage(max_priority_num INT DEFAULT 3)
RETURNS SETOF triage_queue AS $$
  SELECT *
  FROM triage_queue
  WHERE status IN ('pending', 'snoozed')
    AND priority_num <= max_priority_num
    AND (status != 'snoozed' OR snoozed_until <= NOW())
  ORDER BY priority_num ASC, detected_at ASC;
$$ LANGUAGE sql STABLE;

-- RPC: un-snooze expired snoozed items
CREATE OR REPLACE FUNCTION unsnooze_triage_items()
RETURNS INT AS $$
DECLARE
  cnt INT;
BEGIN
  UPDATE triage_queue
  SET status = 'pending', snoozed_until = NULL
  WHERE status = 'snoozed' AND snoozed_until <= NOW();
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END;
$$ LANGUAGE plpgsql;

-- RPC: expire old triage items (older than given hours)
CREATE OR REPLACE FUNCTION expire_old_triage_items(max_age_hours INT DEFAULT 48)
RETURNS INT AS $$
DECLARE
  cnt INT;
BEGIN
  UPDATE triage_queue
  SET status = 'expired'
  WHERE status IN ('pending', 'notified')
    AND detected_at < NOW() - (max_age_hours || ' hours')::INTERVAL;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END;
$$ LANGUAGE plpgsql;
