/**
 * Slack approval flow for methodology insights extracted from Nina/Daniel calls.
 *
 * Flow:
 * 1. Post numbered insight list to SLACK_REVIEW_CHANNEL_ID (or DM as fallback)
 * 2. Per-type Approve/Reject buttons for bulk actions by category
 * 3. Approve All / Reject All buttons for the entire batch
 * 4. Thread replies to cherry-pick: "reject 3, 7, 14" or "approve 1-5, 8"
 * 5. On approve: copies to `methodology_knowledge` + `learnings`
 */

import { env } from "../env.js";
import { logger } from "../utils/logger.js";
import { getDaiSupabase } from "../integrations/dai-supabase.js";
import { addLearning } from "../memory/learnings.js";
import { slackApp } from "../slack/app.js";
import type { MethodologyInsight } from "./methodology-extractor.js";

const ADA_AGENT_ID = "ada";
const SOURCE_SESSION = "nina-daniel-monitoring";

const TYPE_LABELS: Record<string, string> = {
  rule: "Global Rule",
  insight: "Account Insight",
  decision: "Decision Example",
  creative_pattern: "Creative Pattern",
  methodology: "Methodology Step",
};

const TYPE_EMOJI: Record<string, string> = {
  rule: ":blue_book:",
  insight: ":mag:",
  decision: ":scales:",
  creative_pattern: ":art:",
  methodology: ":gear:",
};

export interface PendingInsight {
  id: string;
  meeting_id: string;
  meeting_title: string | null;
  meeting_date: string | null;
  type: string;
  title: string;
  body: Record<string, unknown>;
  account_code: string | null;
  category: string | null;
  confidence: string | null;
  status: string;
  slack_message_ts: string | null;
  seq: number | null;
}

/** Where to post insight reviews */
function getReviewChannel(): string {
  return env.SLACK_REVIEW_CHANNEL_ID ?? env.SLACK_OWNER_USER_ID;
}

// ---------------------------------------------------------------------------
// Send insights for approval
// ---------------------------------------------------------------------------

export async function sendInsightsForApproval(
  insights: MethodologyInsight[],
  meetingId: string,
  meetingTitle: string,
  meetingDate: string,
): Promise<number> {
  if (insights.length === 0) return 0;

  const supabase = getDaiSupabase();

  // 1. Batch insert with sequential numbers
  const rows = insights.map((ins, i) => ({
    meeting_id: meetingId,
    meeting_title: meetingTitle,
    meeting_date: meetingDate,
    type: ins.type,
    title: ins.title,
    body: ins.body,
    account_code: ins.account_code,
    category: ins.category,
    confidence: ins.confidence,
    status: "pending",
    seq: i + 1,
  }));

  const { data: inserted, error } = await supabase
    .from("pending_insights")
    .insert(rows)
    .select("id, seq, type, title, account_code, category, confidence, body");

  if (error) {
    logger.error({ error }, "Failed to insert pending insights");
    throw new Error(`Failed to insert pending insights: ${error.message}`);
  }

  const pendingRows = inserted as Array<{
    id: string;
    seq: number;
    type: string;
    title: string;
    account_code: string | null;
    category: string | null;
    confidence: string | null;
    body: Record<string, unknown>;
  }>;

  // 2. Build Block Kit message
  const blocks = buildApprovalBlocks(pendingRows, meetingId, meetingTitle, meetingDate);
  const channel = getReviewChannel();

  // 3. Post to review channel
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await slackApp.client.chat.postMessage({
    channel,
    blocks: blocks as any,
    text: `${insights.length} methodology insights extracted from "${meetingTitle}" — review and approve/reject`,
  });

  // 4. Store slack_message_ts on pending rows
  if (result.ts) {
    const ids = pendingRows.map((r) => r.id);
    await supabase
      .from("pending_insights")
      .update({ slack_message_ts: result.ts })
      .in("id", ids);

    // 5. Post a helper message in the thread
    await slackApp.client.chat.postMessage({
      channel,
      thread_ts: result.ts,
      text: [
        "Reply in this thread to cherry-pick:",
        "`reject 3, 7, 14` — reject specific items by number",
        "`approve 1-5, 8` — approve a range + individual",
        "`reject all decisions` — reject an entire type",
        "Buttons above handle bulk approve/reject by type or all at once.",
      ].join("\n"),
    });
  }

  logger.info(
    { meetingId, count: insights.length, messageTs: result.ts, channel },
    "Sent insights for approval",
  );

  return insights.length;
}

// ---------------------------------------------------------------------------
// Block Kit builder
// ---------------------------------------------------------------------------

function buildApprovalBlocks(
  insights: Array<{
    id: string;
    seq: number;
    type: string;
    title: string;
    account_code: string | null;
    category: string | null;
    confidence: string | null;
    body: Record<string, unknown>;
  }>,
  meetingId: string,
  meetingTitle: string,
  meetingDate: string,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  // Header
  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: `Insights: ${meetingTitle}`,
      emoji: true,
    },
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${meetingDate} | ${insights.length} insights | Reply in thread to cherry-pick`,
      },
    ],
  });

  // Approve All / Reject All
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Approve All", emoji: true },
        style: "primary",
        action_id: "approve_all_insights",
        value: `meeting:${meetingId}`,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Reject All", emoji: true },
        style: "danger",
        action_id: "reject_all_insights",
        value: `meeting:${meetingId}`,
      },
    ],
  });

  blocks.push({ type: "divider" });

  // Group by type
  const grouped = new Map<string, typeof insights>();
  for (const ins of insights) {
    const group = grouped.get(ins.type) ?? [];
    group.push(ins);
    grouped.set(ins.type, group);
  }

  const MAX_SECTION_CHARS = 2900;

  for (const [type, items] of grouped) {
    const emoji = TYPE_EMOJI[type] ?? ":bulb:";
    const label = TYPE_LABELS[type] ?? type;

    // Per-type Approve/Reject buttons
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: `Approve ${label}s`, emoji: true },
          style: "primary",
          action_id: `approve_type_${type}`,
          value: `meeting:${meetingId}:${type}`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: `Reject ${label}s`, emoji: true },
          style: "danger",
          action_id: `reject_type_${type}`,
          value: `meeting:${meetingId}:${type}`,
        },
      ],
    });

    // Numbered bullet list
    const bullets = items.map((item) => {
      const acct = item.account_code ? ` \`${item.account_code}\`` : "";
      return `*${item.seq}.* ${item.title}${acct}`;
    });

    // Split into chunks that fit within section text limit
    let currentChunk: string[] = [];
    let currentLen = 0;
    let chunkIndex = 0;

    for (const bullet of bullets) {
      if (currentLen + bullet.length + 1 > MAX_SECTION_CHARS && currentChunk.length > 0) {
        const header = chunkIndex === 0
          ? `${emoji} *${label}s* (${items.length})\n`
          : "";
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: header + currentChunk.join("\n") },
        });
        currentChunk = [];
        currentLen = 0;
        chunkIndex++;
      }
      currentChunk.push(bullet);
      currentLen += bullet.length + 1;
    }

    if (currentChunk.length > 0) {
      const header = chunkIndex === 0
        ? `${emoji} *${label}s* (${items.length})\n`
        : "";
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: header + currentChunk.join("\n") },
      });
    }

    blocks.push({ type: "divider" });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Handle approval/rejection actions
// ---------------------------------------------------------------------------

export async function handleInsightAction(
  insightId: string,
  action: "approve" | "reject",
): Promise<void> {
  const supabase = getDaiSupabase();

  const { data: row, error: fetchError } = await supabase
    .from("pending_insights")
    .select("*")
    .eq("id", insightId)
    .single();

  if (fetchError || !row) {
    logger.error({ insightId, error: fetchError }, "Pending insight not found");
    return;
  }

  const insight = row as PendingInsight;

  if (insight.status !== "pending") {
    logger.debug({ insightId, status: insight.status }, "Insight already processed");
    return;
  }

  await supabase
    .from("pending_insights")
    .update({ status: action === "approve" ? "approved" : "rejected", reviewed_at: new Date().toISOString() })
    .eq("id", insightId);

  if (action === "approve") {
    await supabase.from("methodology_knowledge").insert({
      type: insight.type,
      title: insight.title,
      body: insight.body,
      account_code: insight.account_code,
      category: insight.category,
      confidence: insight.confidence,
      source_meeting: insight.meeting_title,
      source_date: insight.meeting_date,
      extraction_run: SOURCE_SESSION,
    });

    const category = insight.type === "rule" ? "methodology_rule" : "account_knowledge";
    const content = insight.account_code
      ? `[${insight.account_code}] ${insight.title}`
      : insight.title;

    await addLearning({
      agent_id: ADA_AGENT_ID,
      category,
      content,
      confidence: insight.confidence === "high" ? 0.8 : 0.6,
      source_session_id: SOURCE_SESSION,
      client_code: insight.account_code,
    });

    logger.info({ insightId, type: insight.type, seq: insight.seq }, "Insight approved");
  } else {
    logger.info({ insightId, type: insight.type, seq: insight.seq }, "Insight rejected");
  }
}

export async function handleBulkInsightAction(
  insightIds: string[],
  action: "approve" | "reject",
): Promise<{ approved: number; rejected: number; skipped: number }> {
  let approved = 0;
  let rejected = 0;
  let skipped = 0;

  for (const id of insightIds) {
    try {
      const supabase = getDaiSupabase();
      const { data } = await supabase
        .from("pending_insights")
        .select("status")
        .eq("id", id)
        .single();

      if (!data || (data as { status: string }).status !== "pending") {
        skipped++;
        continue;
      }

      await handleInsightAction(id, action);
      if (action === "approve") approved++;
      else rejected++;
    } catch (err) {
      logger.error({ insightId: id, error: err }, "Error processing insight action");
      skipped++;
    }
  }

  return { approved, rejected, skipped };
}

// ---------------------------------------------------------------------------
// Thread reply parsing — "reject 3, 7, 14" / "approve 1-5, 8"
// ---------------------------------------------------------------------------

/**
 * Parse a thread reply into an action + set of seq numbers.
 * Supports: "reject 3, 7, 14", "approve 1-5, 8", "reject all decisions"
 */
export function parseThreadReply(text: string): {
  action: "approve" | "reject";
  seqs: number[];
  type: string | null;
} | null {
  const lower = text.toLowerCase().trim();

  // Match "approve/reject all <type>"
  const typeMatch = lower.match(/^(approve|reject)\s+all\s+(\w+)s?$/);
  if (typeMatch) {
    const action = typeMatch[1] as "approve" | "reject";
    // Normalize type name: "global rules" → "rule", "creative patterns" → "creative_pattern"
    let typeName = typeMatch[2]!;
    // Map display labels back to type keys
    const labelToType: Record<string, string> = {
      rule: "rule", global: "rule",
      insight: "insight", account: "insight",
      decision: "decision",
      creative: "creative_pattern", pattern: "creative_pattern",
      methodology: "methodology", step: "methodology",
    };
    typeName = labelToType[typeName] ?? typeName;
    return { action, seqs: [], type: typeName };
  }

  // Match "approve/reject <numbers>"
  const numMatch = lower.match(/^(approve|reject)\s+(.+)$/);
  if (!numMatch) return null;

  const action = numMatch[1] as "approve" | "reject";
  const numPart = numMatch[2]!;

  const seqs: number[] = [];
  // Split by comma or space, parse ranges like "1-5"
  for (const token of numPart.split(/[\s,]+/)) {
    const rangeMatch = token.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = parseInt(rangeMatch[2]!, 10);
      for (let i = start; i <= end; i++) seqs.push(i);
    } else {
      const n = parseInt(token, 10);
      if (!isNaN(n)) seqs.push(n);
    }
  }

  if (seqs.length === 0) return null;
  return { action, seqs, type: null };
}

/**
 * Handle a thread reply by resolving seq numbers to insight IDs and processing.
 */
export async function handleThreadReply(
  messageTs: string,
  text: string,
): Promise<string | null> {
  const parsed = parseThreadReply(text);
  if (!parsed) return null;

  const supabase = getDaiSupabase();

  let query = supabase
    .from("pending_insights")
    .select("id, seq, type, title")
    .eq("slack_message_ts", messageTs)
    .eq("status", "pending");

  if (parsed.type) {
    query = query.eq("type", parsed.type);
  }

  const { data: rows } = await query;
  if (!rows || rows.length === 0) return "No pending insights found for this message.";

  const typedRows = rows as Array<{ id: string; seq: number; type: string; title: string }>;

  // If type-based ("reject all decisions"), process all matching rows
  let targets: typeof typedRows;
  if (parsed.type) {
    targets = typedRows;
  } else {
    // Filter by seq numbers
    const seqSet = new Set(parsed.seqs);
    targets = typedRows.filter((r) => seqSet.has(r.seq));
  }

  if (targets.length === 0) {
    return `No matching pending insights found for: ${text}`;
  }

  const result = await handleBulkInsightAction(
    targets.map((r) => r.id),
    parsed.action,
  );

  const verb = parsed.action === "approve" ? "Approved" : "Rejected";
  const items = targets.map((t) => `#${t.seq}`).join(", ");
  return `${verb} ${result.approved + result.rejected} insights (${items})` +
    (result.skipped > 0 ? ` — ${result.skipped} already processed` : "");
}

/**
 * Update the original Slack message after an action is taken.
 */
export async function updateApprovalMessage(
  channel: string,
  messageTs: string,
  summary: string,
): Promise<void> {
  try {
    // Post a reply in the thread rather than replacing the message
    await slackApp.client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: summary,
    });
  } catch (err) {
    logger.error({ err, messageTs }, "Failed to post approval update");
  }
}
