-- action log: first-class client attribution + a reversible-write query surface.
--
-- WHY (Dan, 2026-07-26): "everything Ada does, I need to know what was done and
-- whether at some later point we need to reverse things."
--
-- Two gaps found while auditing the log on 2026-07-26:
--
-- 1. NO CLIENT COLUMN. A client-scoped Ada session is distinguishable (agent_id
--    becomes `ada_client_<CODE>`), but an AGENCY action targeting a client logs
--    as plain `ada` with the client buried inside the params JSON. So "what did
--    we change in client X's account?" was not answerable with a WHERE clause.
--
-- 2. Of Ada's 2,726 logged actions, 4 carried before_state/after_state/
--    reverse_action — all four Notion bookkeeping. Every Meta account change
--    (38 media uploads, 13 ad launches) logged as action_type='tool_call'
--    telemetry only: no prior state, no undo instruction. The columns existed;
--    nothing populated them for Meta. Fixed in the same batch as this migration
--    (see logWrite callers in src/agents/tool-registry.ts).

ALTER TABLE piper_actions
  ADD COLUMN IF NOT EXISTS client_code TEXT;

COMMENT ON COLUMN piper_actions.client_code IS
  'Which client/ad account this action affected. Resolved from the session''s client scope when present, otherwise from the tool params. NULL for actions with no client target (memory writes, general reads).';

CREATE INDEX IF NOT EXISTS piper_actions_client_timestamp_idx
  ON piper_actions (client_code, timestamp DESC)
  WHERE client_code IS NOT NULL;

-- WHY + WHO ASKED (Dan, 2026-07-26): "save the reason why ada did it and the
-- reasoning behind this. Also, if this is something that ada has done
-- autonomously, or it has been suggested by the client, or ada suggested it and
-- the client green-lit it."

ALTER TABLE piper_actions
  ADD COLUMN IF NOT EXISTS reason TEXT;

COMMENT ON COLUMN piper_actions.reason IS
  'Ada''s own stated reasoning for this action, in her words. Self-reported by design — the point is to capture her thinking, not to verify it. Several write tools already require a `reason` param; this is where it lands.';

ALTER TABLE piper_actions
  ADD COLUMN IF NOT EXISTS initiated_by TEXT;

COMMENT ON COLUMN piper_actions.initiated_by IS
  'Who caused this action. Values: autonomous (Ada decided unprompted) | scheduled (a timer fired, no decision) | client_requested (a client asked directly) | client_approved (Ada proposed, client green-lit) | agency_requested (someone at the agency asked) | agency_approved (Ada proposed, agency green-lit). NOTE: as of 2026-07-26 almost nothing is autonomous — nearly every Ada write is triggered by a human in Slack or the launch console, which is why the agency_* values exist. Without them today''s reality would be mislabelled as autonomous.';

ALTER TABLE piper_actions
  ADD COLUMN IF NOT EXISTS initiation_evidence TEXT;

COMMENT ON COLUMN piper_actions.initiation_evidence IS
  'How much to trust initiated_by. `derived` = established by the runtime and not by the model (a client-scoped session is definitionally client-initiated; a cron run is scheduled; an approval-button handler knows a human clicked). `self_reported` = the model asserted it, e.g. "the client said yes in conversation" — treat as a claim, not a fact. Never leave NULL on a write row: an unlabelled claim is the thing this column exists to prevent.';

CREATE INDEX IF NOT EXISTS piper_actions_initiated_by_idx
  ON piper_actions (initiated_by, timestamp DESC)
  WHERE initiated_by IS NOT NULL;

-- Reversible writes only. This is the surface to answer "what did we change and
-- how do we undo it?" — one row per state change, newest first.
CREATE OR REPLACE VIEW public.agent_reversible_writes AS
  SELECT
    id,
    timestamp,
    agent_id,
    client_code,
    tool_name,
    target_system,
    target_id,
    before_state,
    after_state,
    reverse_action,
    reason,
    initiated_by,
    initiation_evidence,
    result_summary,
    status,
    user_id,
    session_id
  FROM public.piper_actions
  WHERE action_type = 'write'
  ORDER BY timestamp DESC;

COMMENT ON VIEW public.agent_reversible_writes IS
  'Every state-changing agent write: before/after state, a machine-readable reverse_action, Ada''s stated reason, and who asked for it. Use this to audit or undo agent activity. Two honesty rules when reading it: (1) reverse_action = NULL means NOT automatically reversible — check result_summary for what a human must do instead; (2) initiation_evidence = self_reported means initiated_by is the model''s claim, not an established fact.';

GRANT SELECT ON public.agent_reversible_writes TO service_role;
GRANT SELECT ON public.agent_reversible_writes TO authenticated;
