/**
 * Launch-claim guard — post-response QC.
 *
 * Born from the 2026-06-05 Sweetspot incident: Nina approved a launch ("aunch both")
 * and Ada replied "Both launched and verified clean 🟢" in a single turn with ZERO
 * tool calls — /api/ada/launch never fired, launch_batches stayed `pending`, and the
 * follow-up "re-check" deep-linked the wrong ad account (the AOT health-check
 * campaign). Pure pattern-completion: the model role-played the launch script
 * instead of executing it, and nothing checked the claim against reality.
 *
 * Defense: before a reply that CLAIMS a completed launch/verification reaches Slack,
 * require ground truth — either a launch/verify tool actually executed (successfully)
 * in this run, or the bmad DB shows a batch flipped to 'launched' recently (covers
 * turns that merely summarize a launch executed earlier in the same thread).
 * Otherwise a loud UNCONFIRMED banner is appended to the reply and the event is
 * logged at error level so it shows up in journalctl triage.
 *
 * Deliberately high-precision patterns: completion REPORTS only. Proposals
 * ("ready to launch", "want me to launch both?") must never match.
 */
import { getSupabase } from "../../integrations/supabase.js";
import { logger } from "../../utils/logger.js";

export interface ExecutedToolCall {
  name: string;
  isError: boolean;
}

/** Tools whose successful execution is ground truth for a launch claim. */
const LAUNCH_PROOF_TOOLS = new Set(["launch_ads", "verify_launch", "pause_launch"]);

/**
 * Completion-report patterns. Each is anchored on a past-tense launch/verify claim;
 * generic performance talk ("5 ads are live this week") intentionally does not match.
 */
const CLAIM_PATTERNS: RegExp[] = [
  /\blaunch(ed)?\s+(and|&)\s+verif/i, // "launched and verified (clean)"
  /\bboth\s+launched\b/i,
  /\bsuccessfully\s+launched\b/i,
  /\bverified\s+clean\b/i,
  /\blaunched\b[^\n]{0,80}(:large_green_circle:|🟢)/i,
  /(:large_green_circle:|🟢)[^\n]{0,80}\bverif/i,
  /\blaunched\s*\(paused\)/i,
  /\bconfirmed\s+live\s+in\s+meta\b/i,
  /\bverify\b[^\n]{0,40}\b(passed|clean|ok)\b/i,
];

/** A launched_at within this window counts as "the launch this reply talks about". */
const RECENT_LAUNCH_WINDOW_MIN = 45;

export function detectLaunchClaim(text: string): boolean {
  return CLAIM_PATTERNS.some((re) => re.test(text));
}

export interface LaunchClaimGuardResult {
  flagged: boolean;
  /** Slack-markdown banner to append to the reply when flagged. */
  warning?: string;
}

export async function runLaunchClaimGuard(params: {
  responseText: string;
  executedTools: ExecutedToolCall[];
  agentId: string;
  sessionId: string;
}): Promise<LaunchClaimGuardResult> {
  const { responseText, executedTools, agentId, sessionId } = params;

  if (!detectLaunchClaim(responseText)) return { flagged: false };

  // Ground truth 1: a launch/verify tool actually ran (successfully) this run.
  const proofTool = executedTools.find(
    (t) => LAUNCH_PROOF_TOOLS.has(t.name) && !t.isError,
  );
  if (proofTool) return { flagged: false };

  // Ground truth 2: the DB shows a real launch in the last N minutes — covers
  // follow-up turns that summarize a launch executed earlier in the thread
  // (possibly by a different process, e.g. a Slack button handler).
  try {
    const since = new Date(Date.now() - RECENT_LAUNCH_WINDOW_MIN * 60_000).toISOString();
    const { data, error } = await getSupabase()
      .from("launch_batches")
      .select("batch_id,launched_at")
      .eq("status", "launched")
      .gte("launched_at", since)
      .limit(1);
    if (!error && data && data.length > 0) {
      logger.warn(
        { agentId, sessionId, recentBatch: data[0]?.batch_id },
        "launch-claim-guard: launch claim without a tool call this run, but a recently-launched batch exists — passing",
      );
      return { flagged: false };
    }
    if (error) {
      logger.warn({ error }, "launch-claim-guard: launch_batches query errored — treating claim as unverified");
    }
  } catch (err) {
    logger.warn({ err }, "launch-claim-guard: DB cross-check failed — treating claim as unverified");
  }

  logger.error(
    { agentId, sessionId, executedTools: executedTools.map((t) => t.name) },
    "launch-claim-guard: FLAGGED unverified launch claim (no launch tool ran, no recently-launched batch in DB)",
  );

  const warning =
    "\n\n:rotating_light: *AUTOMATED QC — UNVERIFIED LAUNCH CLAIM.* " +
    "The message above claims a completed launch/verification, but no launch or verify tool was executed in this turn, " +
    `and no batch has flipped to \`launched\` in the database in the last ${RECENT_LAUNCH_WINDOW_MIN} minutes. ` +
    "*Treat the claim as FALSE — nothing has been launched.* " +
    "Re-approve the launch and confirm a real `launch_ads` + `verify_launch` result, or check `launch_batches` for the batch status. _(launch-claim-guard)_";

  return { flagged: true, warning };
}
