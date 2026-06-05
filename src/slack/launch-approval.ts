/**
 * Deterministic text-approval routing for Ada's launch flow.
 *
 * 2026-06-05 incident root cause: the [Launch] button routes deterministically
 * through launch-actions.ts, but a typed approval ("launch both", or Nina's
 * "aunch both" typo) goes through the model — which that day answered with a
 * fully fabricated success report and zero tool calls.
 *
 * This module intercepts thread replies BEFORE the model runs: if the reply is
 * an unambiguous approval AND the thread's session history references batches
 * that are still `pending` in launch_batches, we call launchAds + verifyLaunch
 * directly (same code path as the button) and post a result message rendered
 * from the tool output. The model is not in the loop; it cannot fabricate.
 *
 * Anything ambiguous (negations, questions, subset qualifiers like "just the
 * statics", no pending batches found) falls through to the model unchanged.
 */
import { logger } from "../utils/logger.js";
import { launchAds, verifyLaunch } from "../agents/tools/ad-launch-tools.js";
import { getPendingBatchesFromTexts, type BatchState } from "../agents/launch-state.js";
import { findSession } from "../memory/sessions.js";
import { getMessages, addMessage } from "../memory/messages.js";

// ---------------------------------------------------------------------------
// Approval matching — deliberately conservative. False negative = model handles
// it (now backstopped by launch-claim-guard). False positive = real Meta write,
// so precision wins over recall.
// ---------------------------------------------------------------------------

/** Any of these anywhere → never auto-launch. */
const NEGATION_RE = /\b(don'?t|do not|not|no|hold|wait|stop|cancel|nope|später|nicht)\b/i;

/** Subset/qualifier language we can't resolve deterministically → model handles it. */
const SUBSET_RE = /\b(only|just|first|except|skip|one of|statics?|videos?|images?)\b/i;

/** Edits or conditions attached to the approval ("change X then launch") → model handles it. */
const CONDITION_RE = /\b(change|edit|fix|update|swap|replace|rename|but|after|once|if|when|then|bevor|danach)\b/i;

/** Launch verb, including the leading-letter typo that triggered the incident
 *  ("aunch both") — "aunch" is not an English word, so this is safe. */
const LAUNCH_VERB_RE = /\b(l?aunch(es|ed|ing)?|fire (them|both|it|all)|ship (them|both|it|all))\b/i;

/** Bare affirmation — only honored when the previous assistant message asked about launching. */
const BARE_AFFIRM_RE =
  /^\s*(yes+|yep|yeah|ok(ay)?|sure|go|go ahead|do it|approved?|confirmed?|ja|ja los|los|mach|:thumbsup:|👍|🚀)(\s*,?\s*(please|both|all|them|los|ahead|bitte))*[\s.,!🚀👍]*$/i;

export type ApprovalMatch = "launch_verb" | "bare_affirm" | null;

export function matchApproval(text: string): ApprovalMatch {
  const t = text.trim();
  if (!t || t.length > 120) return null; // long messages carry nuance — model territory
  if (t.includes("?")) return null; // questions are never approvals
  if (NEGATION_RE.test(t)) return null;
  if (SUBSET_RE.test(t)) return null;
  if (CONDITION_RE.test(t)) return null;
  if (LAUNCH_VERB_RE.test(t)) return "launch_verb";
  if (BARE_AFFIRM_RE.test(t)) return "bare_affirm";
  return null;
}

// ---------------------------------------------------------------------------
// Deterministic execution
// ---------------------------------------------------------------------------

function describeVerify(verifyJson: string): string {
  try {
    const v = JSON.parse(verifyJson) as Record<string, unknown>;
    if (v.error) return `verify errored: ${v.error}`;
    return `${v.verdict ?? "?"} (fail ${v.fail_count ?? "?"} / warn ${v.warn_count ?? "?"})`;
  } catch {
    return "verify result unparseable";
  }
}

async function executeBatch(
  batch: BatchState,
  idempotencyKey: string,
): Promise<{ ok: boolean; line: string }> {
  const resultJson = await launchAds({
    batch_id: batch.batch_id,
    idempotency_key: idempotencyKey,
  });
  let result: Record<string, unknown> = {};
  try { result = JSON.parse(resultJson); } catch { /* keep empty */ }

  if (result.error || result.status !== "launched") {
    return {
      ok: false,
      line: `:x: \`${batch.batch_id.slice(0, 8)}\` (${batch.client_code}) launch FAILED — ${result.error ?? `status=${result.status}`}`,
    };
  }

  const adIds = (result.ad_ids ?? []) as string[];
  const adsetId = result.adset_id as string | undefined;
  const adsManagerUrl = result.ads_manager_url as string | undefined;
  const verify = describeVerify(await verifyLaunch({ batch_id: batch.batch_id }));
  const replay = result.idempotent_replay === true ? " _(replay)_" : "";

  return {
    ok: true,
    line:
      `:rocket: \`${batch.batch_id.slice(0, 8)}\` (${batch.client_code}) launched${replay} — ` +
      `adset \`${adsetId}\`, ${adIds.length} ad${adIds.length === 1 ? "" : "s"} PAUSED · verify ${verify}` +
      (adsManagerUrl ? ` · <${adsManagerUrl}|Ads Manager>` : ""),
  };
}

export interface ApprovalRouteParams {
  text: string;
  channelId: string;
  threadTs: string;
  agentId: string;
  userId: string;
  /** Post a message into the thread (already bound to channel+thread). */
  postReply: (text: string) => Promise<void>;
}

/**
 * Try to handle a thread reply as a deterministic launch approval.
 * Returns true if handled (caller must NOT run the model for this message).
 */
export async function tryDeterministicLaunchApproval(
  params: ApprovalRouteParams,
): Promise<boolean> {
  const { text, channelId, threadTs, agentId, userId, postReply } = params;

  const match = matchApproval(text);
  if (!match) return false;

  // Find the thread's session + history. No session / no batches → model handles it.
  const session = await findSession(channelId, threadTs, agentId).catch(() => null);
  if (!session) return false;
  const history = await getMessages(session.id, 20).catch(() => []);
  if (history.length === 0) return false;

  // Bare affirmations only count when the last assistant message was about launching.
  if (match === "bare_affirm") {
    const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant || !/launch/i.test(lastAssistant.content)) return false;
  }

  const pending = await getPendingBatchesFromTexts(history.map((m) => m.content));
  if (pending.length === 0) return false;

  logger.info(
    { channelId, threadTs, agentId, userId, match, batches: pending.map((b) => b.batch_id) },
    "Deterministic launch approval — executing without the model",
  );

  await postReply(
    `:gear: Launch approved by <@${userId}> — executing ${pending.length} pending batch${pending.length === 1 ? "" : "es"} deterministically…`,
  );

  const lines: string[] = [];
  let allOk = true;
  for (const batch of pending) {
    // Stable per (batch, approval message): Slack retries reproduce the same key.
    const result = await executeBatch(batch, `ada_launch:${batch.batch_id}:${threadTs}:${userId}`);
    lines.push(result.line);
    if (!result.ok) allOk = false;
  }
  lines.push("");
  lines.push(
    allOk
      ? "_All results above are rendered from live launch + verify tool output (deterministic path — no model involved)._"
      : ":warning: _At least one batch failed — nothing was fabricated; the errors above are the real tool output._",
  );

  const summary = lines.join("\n");
  await postReply(summary);

  // Keep the model's session history coherent: record what actually happened so
  // follow-up turns (handled by the model) see the real state.
  try {
    await addMessage({ session_id: session.id, role: "user", content: text });
    await addMessage({
      session_id: session.id,
      role: "assistant",
      content: `[deterministic launch-approval handler] ${summary}`,
    });
  } catch (err) {
    logger.warn({ err }, "launch-approval: failed to persist session messages");
  }

  return true;
}
