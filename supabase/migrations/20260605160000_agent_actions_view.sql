-- agent_actions: discoverability view over piper_actions.
--
-- piper_actions has logged EVERY dai agent's tool calls since 2026-05-24
-- (executeTool → logToolCall, agent_id column distinguishes Ada/Piper/Maya/…),
-- but the table name hides that. During the 2026-06-05 fabricated-launch
-- forensics the per-tool audit trail wasn't found at first because nobody
-- thought to look in a "piper" table for Ada's actions.
--
-- This view is the canonical query surface going forward: any
-- "did agent X actually do Y?" question is:
--   SELECT * FROM agent_actions WHERE agent_id='ada' AND timestamp > ... ;
-- The underlying table keeps its legacy name so existing inserts/dashboards
-- are untouched.

CREATE OR REPLACE VIEW public.agent_actions AS
  SELECT * FROM public.piper_actions;

COMMENT ON VIEW public.agent_actions IS
  'All dai agents'' tool calls and writes (Ada, Piper, Maya, …) — alias of piper_actions (legacy name). One row per tool call (action_type=tool_call); state-changing writes (action_type=write) carry before_state/after_state/reverse_action.';

GRANT SELECT ON public.agent_actions TO service_role;
GRANT SELECT ON public.agent_actions TO authenticated;
