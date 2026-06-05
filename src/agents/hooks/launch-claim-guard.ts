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

// ---------------------------------------------------------------------------
// Additional claim families (same incident, different fabrications: Ada also
// claimed "marked both Notion tasks Done … all writes logged with reverse
// actions" and "posting the handoff to Nina now" — none of it happened).
// Each family: completion-report patterns + the tools whose successful
// execution this run proves the claim. No DB fallback — these are only
// flagged when the claim describes work done "just now" in this same reply.
// ---------------------------------------------------------------------------

interface ClaimFamily {
  name: string;
  /** Past-tense, just-now completion reports. Proposals must not match. */
  patterns: RegExp[];
  /** Successful same-run execution of any of these proves the claim. */
  proofTools: Set<string>;
  /** What the banner says this claim concerns. */
  label: string;
}

const EXTRA_CLAIM_FAMILIES: ClaimFamily[] = [
  {
    name: "notion_write",
    patterns: [
      /\bmark(ed|ing)\b[^\n]{0,60}\b(done|completed)\b/i, // "marking both tasks Done"
      /\btasks?\s*(→|->)\s*done\b/i, // "Upload task → Done"
      /\bstage\s*(→|->)\s*['"`]?completed\b/i, // "ad set Stage → Completed"
      /\bflipp(ed|ing)\b[^\n]{0,50}\b(stage|status)\b/i,
      /\bnotion\b[^\n]{0,50}\b(closed out|updated|is closed)\b/i,
      /\bclos(ed|ing) out\b[^\n]{0,40}\bnotion\b/i,
      /\bwrites?\s+(are|were)\s+logged\b/i, // "all four writes are logged with reverse actions"
    ],
    proofTools: new Set([
      "update_aot_task_status",
      "update_aot_ad_set_stage",
      "update_aot_task_due_date",
      "update_task",
      "create_task",
      "add_task_comment",
    ]),
    label: "a Notion update",
  },
  {
    name: "slack_post",
    patterns: [
      /\bposted\s+(the\s+)?(handoff|digest|summary|update)\b/i,
      /\bposting\s+the\s+handoff\b/i,
      /\b(looped\s+\S+\s+in|\S+\s+looped\s+in)\b/i, // "looped Nina in" / "Nina looped in"
      /\bnotified\s+\S+\b/i,
      /\bhandoff\s+(is\s+)?(posted|sent|done)\b/i,
      /\bsent\s+(the\s+)?(message|handoff|digest)\s+to\b/i,
    ],
    proofTools: new Set(["post_message", "reply_in_thread", "send_as_daniel", "send_email"]),
    label: "a Slack post/handoff",
  },
];

/** Exposed for tests. */
export function detectExtraClaims(text: string): string[] {
  return EXTRA_CLAIM_FAMILIES.filter((f) => f.patterns.some((re) => re.test(text))).map(
    (f) => f.name,
  );
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

  // Non-launch claim families first (Notion writes, Slack posts) — soft banner.
  const extraWarnings: string[] = [];
  for (const family of EXTRA_CLAIM_FAMILIES) {
    if (!family.patterns.some((re) => re.test(responseText))) continue;
    const proven = executedTools.some((t) => family.proofTools.has(t.name) && !t.isError);
    if (proven) continue;
    logger.error(
      { agentId, sessionId, family: family.name, executedTools: executedTools.map((t) => t.name) },
      "launch-claim-guard: unverified non-launch claim (no matching tool ran this turn)",
    );
    extraWarnings.push(
      `:warning: _Automated QC: the message above claims ${family.label}, but no matching tool ran in this turn — verify in \`agent_actions\` before trusting it._`,
    );
  }
  const extraWarning = extraWarnings.length > 0 ? "\n\n" + extraWarnings.join("\n") : undefined;

  if (!detectLaunchClaim(responseText)) {
    return extraWarning ? { flagged: true, warning: extraWarning } : { flagged: false };
  }

  // Ground truth 1: a launch/verify tool actually ran (successfully) this run.
  const proofTool = executedTools.find(
    (t) => LAUNCH_PROOF_TOOLS.has(t.name) && !t.isError,
  );
  if (proofTool) {
    return extraWarning ? { flagged: true, warning: extraWarning } : { flagged: false };
  }

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
      return extraWarning ? { flagged: true, warning: extraWarning } : { flagged: false };
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

  return { flagged: true, warning: warning + (extraWarning ?? "") };
}
