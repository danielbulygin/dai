-- The insight ledger — Ada's patient chart (DAI Supabase).
-- Designed 2026-08-06 (media-buyer vision; loops implementation plan §1b).
--
-- An insight is a stored record, not a sentence in a report: the claim, when it
-- was derived, the evidence window and method, and a cheap re-check. Mornings
-- re-verify, they don't re-derive; full analysis runs on triggers only.
--
-- ONE unified ledger, multi-level by design (Daniel, 2026-08-06 night):
-- insights attach to entities at every level — account, campaign, ad set, ad,
-- creative (keyed on content hash so the insight survives the ad being
-- duplicated across ad sets), and business for beyond-account findings
-- (landing page, funnel). One table because the lifecycle, status machine and
-- re-check walker are identical at every level, and queries cross levels.
--
-- NEVER delete rows. Resolved and contradicted insights stay — "what we used
-- to believe and why we stopped" is the never-repeat-mistakes memory.
--
-- v1 writers: the morning brief (kind daily-observation, launch-watch).
-- The re-check walker arrives with Loop 3.

create table if not exists ada_insights (
  id uuid primary key default gen_random_uuid(),
  client_code text not null,
  ad_account_id text,
  entity_level text not null default 'account'
    check (entity_level in ('account', 'campaign', 'adset', 'ad', 'creative', 'business')),
  entity_id text,                -- the object id; for creative = content_hash; null for business
  entity_name text,              -- display-name snapshot at derivation time (names drift)
  related_entities jsonb,        -- optional: other entities a cross-cutting insight touches
  kind text not null,            -- daily-observation | launch-watch | root-cause | creative | drift
  claim text not null,           -- one sentence, human-readable
  evidence jsonb not null,       -- window, method, the numbers, source rows
  recheck jsonb,                 -- null = not re-checkable; else {metric, scope, comparator, value}
  status text not null default 'active'
    check (status in ('active', 'confirmed', 'stale', 'resolved', 'contradicted')),
  trajectory jsonb not null default '[]', -- appended per re-check: {date, value, verdict}
  source text not null,          -- loop-1-brief | loop-2-watch | loop-3-analysis | chat
  derived_at timestamptz not null default now(),
  last_checked_at timestamptz,
  resolved_at timestamptz
);

create index if not exists ada_insights_client_status_idx
  on ada_insights (client_code, status);
create index if not exists ada_insights_client_entity_idx
  on ada_insights (client_code, entity_level, entity_id);

-- Service-key only, like the rest of the DAI project.
alter table ada_insights enable row level security;
