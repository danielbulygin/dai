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
      /\bmark(ed|ing)\b[^\n]{0,60}\b(done|completed|in progress|blocked|not started)\b/i, // "marking both tasks Done" / "...In Progress"
      // Any "task(s) → <real status>" arrow claim, not just Done — the 2026-06-12
      // Piper fabrication was "Glaira's four design tasks → In Progress".
      /\btasks?\b[^\n]{0,40}(→|->)\s*[*_"'“]*(done|completed|in progress|blocked|not started|cancelled|archived)/i,
      /\bstage\s*(→|->)\s*['"`]?\w/i, // "ad set Stage → <anything>"
      /\bflipp(ed|ing)\b[^\n]{0,50}\b(stage|status)\b/i,
      /\bset(ting)?\b[^\n]{0,60}\bto\s+[*_"'“]*(in progress|not started|blocked|done|cancelled|archived)/i, // "Setting Glaira's four tasks to In Progress now"
      /\bnotion\b[^\n]{0,50}\b(closed out|updated|is closed)\b/i,
      /\bclos(ed|ing) out\b[^\n]{0,40}\bnotion\b/i,
      /\bwrites?\s+(are|were)\s+logged\b/i, // "all four writes are logged with reverse actions"
      /\ball logged\b/i, // "All logged — say the word and I'll revert"
      /\b(all\s+)?(four|three|two|five|\d+)\s+(tasks?\s+)?created\b/i, // "All four created, Glaira assigned"
      /\btasks?\s+created\b/i,
      /\bcreated\b[^\n]{0,60}\b(assigned|due\s+\w)/i,
      /\bsay the word and i.?ll (revert|archive|undo)\b/i, // undo offers imply a claimed write
      /\bfiled the correction\b/i,
    ],
    proofTools: new Set([
      "update_aot_task_status",
      "update_aot_ad_set_stage",
      "update_aot_task_due_date",
      "create_aot_task",
      "log_pipeline_correction",
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

// ---------------------------------------------------------------------------
// Fabricated tool transcripts (2026-06-12 Piper incident): the runner stores
// each assistant turn in session history with a machine-appended
// "[internal — …]" tool digest. Piper saw that format in its history and
// MIMICKED it — wrote a fake digest with invented ok:true results for four
// status writes it never executed (turns=1, zero tool calls) and posted it to
// the channel. The marker is storage-only; it NEVER legitimately appears in
// response text — so its presence (or hand-written `tool({...}) → {...}`
// transcript lines) is fabrication by definition, regardless of what else ran.
// ---------------------------------------------------------------------------

const FABRICATED_TRANSCRIPT_PATTERNS: RegExp[] = [
  /\[internal\s*[—-]/i, // the storage marker, model-written
  /\[machine-appended tool digest/i, // current marker wording
  /\w+\(\{[^\n]*\}\)\s*(→|->)\s*\{\s*"?ok"?\s*:/i, // tool({...}) → {"ok":...
];

/** Exposed for tests. */
export function detectFabricatedTranscript(text: string): boolean {
  return FABRICATED_TRANSCRIPT_PATTERNS.some((re) => re.test(text));
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

  // Fabricated tool transcript — hard banner, unconditional. The "[internal —"
  // digest marker and tool({...}) → {...} transcript lines are never legitimate
  // in response text; the runner appends digests to STORED history only.
  const extraWarnings: string[] = [];
  if (detectFabricatedTranscript(responseText)) {
    logger.error(
      { agentId, sessionId, executedTools: executedTools.map((t) => t.name) },
      "launch-claim-guard: FABRICATED tool transcript in response text",
    );
    extraWarnings.push(
      ":rotating_light: *AUTOMATED QC — FABRICATED TOOL TRANSCRIPT.* " +
        "The message above contains what is formatted as tool output, but that block was WRITTEN BY THE MODEL, not produced by any tool. " +
        "*Treat every \"result\" in it as FALSE* — check `piper_actions` / the actual system for what (if anything) really happened. _(launch-claim-guard)_",
    );
  }

  // Non-launch claim families (Notion writes, Slack posts) — soft banner.
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
