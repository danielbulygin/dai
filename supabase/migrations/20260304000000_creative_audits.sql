-- Creative audits table for Maya's format × angle × style tracking
-- Stores per-client creative coordinate distribution snapshots

CREATE TABLE IF NOT EXISTS creative_audits (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_code TEXT NOT NULL,
  audit_date DATE NOT NULL DEFAULT CURRENT_DATE,
  format_distribution JSONB NOT NULL,    -- { "F01": { "spend_pct": 0.45, "count": 12, "spend": 1234.56 }, ... }
  angle_distribution JSONB NOT NULL,     -- { "A01": { "spend_pct": 0.30, "count": 8, "spend": 823.45 }, ... }
  style_distribution JSONB NOT NULL,     -- { "lo-fi": { "spend_pct": 0.60, "count": 15 }, ... }
  gap_matrix JSONB NOT NULL,             -- { "untested": ["F02×A04", ...], "underweight": ["F06×A05", ...] }
  top_performers JSONB,                  -- [{ "ad_id": "...", "format": "F01", "angle": "A01", "roas": 3.5, ... }]
  total_spend NUMERIC,
  total_ads INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_creative_audits_client ON creative_audits(client_code, audit_date DESC);
