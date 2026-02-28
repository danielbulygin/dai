/**
 * Slack approval flow for methodology insights extracted from Nina/Daniel calls.
 *
 * - Batch-inserts insights into `pending_insights` in Supabase
 * - Sends Block Kit message to Daniel with approve/reject buttons
 * - On approve: copies to `methodology_knowledge` + `learnings` (for recall)
 * - On reject: marks as rejected, no further action
 */

import { env } from "../env.js";
import { logger } from "../utils/logger.js";
import { getDaiSupabase } from "../integrations/dai-supabase.js";
import { addLearning } from "../memory/learnings.js";
import { slackApp } from "../slack/app.js";
import type { MethodologyInsight } from "./methodology-extractor.js";

const ADA_AGENT_ID = "ada";
const SOURCE_SESSION = "nina-daniel-monitoring";

// Type labels for display
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
}

// ---------------------------------------------------------------------------
// Send insights for approval
// ---------------------------------------------------------------------------

/**
 * Insert insights as pending in Supabase, then DM Daniel with Block Kit buttons.
 * Returns the number of insights sent for approval.
 */
export async function sendInsightsForApproval(
  insights: MethodologyInsight[],
  meetingId: string,
  meetingTitle: string,
  meetingDate: string,
): Promise<number> {
  if (insights.length === 0) return 0;

  const supabase = getDaiSupabase();

  // 1. Batch insert into pending_insights
  const rows = insights.map((i) => ({
    meeting_id: meetingId,
    meeting_title: meetingTitle,
    meeting_date: meetingDate,
    type: i.type,
    title: i.title,
    body: i.body,
    account_code: i.account_code,
    category: i.category,
    confidence: i.confidence,
    status: "pending",
  }));

  const { data: inserted, error } = await supabase
    .from("pending_insights")
    .insert(rows)
    .select("id, type, title, account_code, category, confidence, body");

  if (error) {
    logger.error({ error }, "Failed to insert pending insights");
    throw new Error(`Failed to insert pending insights: ${error.message}`);
  }

  const pendingRows = inserted as Array<{
    id: string;
    type: string;
    title: string;
    account_code: string | null;
    category: string | null;
    confidence: string | null;
    body: Record<string, unknown>;
  }>;

  // 2. Build Block Kit message
  const blocks = buildApprovalBlocks(pendingRows, meetingTitle, meetingDate);

  // 3. DM Daniel
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await slackApp.client.chat.postMessage({
    channel: env.SLACK_OWNER_USER_ID,
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
  }

  logger.info(
    { meetingId, count: insights.length, messageTs: result.ts },
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
    type: string;
    title: string;
    account_code: string | null;
    category: string | null;
    confidence: string | null;
    body: Record<string, unknown>;
  }>,
  meetingTitle: string,
  meetingDate: string,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  // Header
  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: `New insights from: ${meetingTitle}`,
      emoji: true,
    },
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Meeting date: ${meetingDate} | ${insights.length} insights extracted`,
      },
    ],
  });

  // Approve All / Reject All buttons
  const meetingId = insights[0]?.id ? insights[0].id.split("-")[0] : "batch";
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Approve All", emoji: true },
        style: "primary",
        action_id: "approve_all_insights",
        value: insights.map((i) => i.id).join(","),
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Reject All", emoji: true },
        style: "danger",
        action_id: "reject_all_insights",
        value: insights.map((i) => i.id).join(","),
      },
    ],
  });

  blocks.push({ type: "divider" });

  // Group insights by type
  const grouped = new Map<string, typeof insights>();
  for (const insight of insights) {
    const group = grouped.get(insight.type) ?? [];
    group.push(insight);
    grouped.set(insight.type, group);
  }

  for (const [type, items] of grouped) {
    const emoji = TYPE_EMOJI[type] ?? ":bulb:";
    const label = TYPE_LABELS[type] ?? type;

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} *${label}s* (${items.length})`,
      },
    });

    for (const item of items) {
      const parts: string[] = [`*${item.title}*`];

      if (item.account_code) {
        parts.push(`Account: \`${item.account_code}\``);
      }
      if (item.category) {
        parts.push(`Category: ${item.category}`);
      }
      if (item.confidence) {
        parts.push(`Confidence: ${item.confidence}`);
      }

      // Add body details if present
      const bodyDetails = Object.entries(item.body)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => `_${k}_: ${String(v).slice(0, 200)}`)
        .join("\n");
      if (bodyDetails) {
        parts.push(bodyDetails);
      }

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: parts.join("\n"),
        },
        accessory: {
          type: "overflow",
          action_id: `insight_action_${item.id}`,
          options: [
            {
              text: { type: "plain_text", text: "Approve" },
              value: `approve_${item.id}`,
            },
            {
              text: { type: "plain_text", text: "Reject" },
              value: `reject_${item.id}`,
            },
          ],
        },
      });
    }

    blocks.push({ type: "divider" });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Handle approval/rejection actions
// ---------------------------------------------------------------------------

/**
 * Process a single insight approval or rejection.
 */
export async function handleInsightAction(
  insightId: string,
  action: "approve" | "reject",
): Promise<void> {
  const supabase = getDaiSupabase();

  // Fetch the pending insight
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

  // Update status
  await supabase
    .from("pending_insights")
    .update({ status: action === "approve" ? "approved" : "rejected", reviewed_at: new Date().toISOString() })
    .eq("id", insightId);

  if (action === "approve") {
    // Insert into methodology_knowledge
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

    // Also add to learnings for recall/auto-injection
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

    logger.info({ insightId, type: insight.type }, "Insight approved and saved");
  } else {
    logger.info({ insightId, type: insight.type }, "Insight rejected");
  }
}

/**
 * Process bulk approve/reject for a list of insight IDs.
 */
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

/**
 * Update the original Slack message after an action is taken.
 */
export async function updateApprovalMessage(
  channel: string,
  messageTs: string,
  summary: string,
): Promise<void> {
  try {
    await slackApp.client.chat.update({
      channel,
      ts: messageTs,
      text: summary,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: summary,
          },
        },
      ],
    });
  } catch (err) {
    logger.error({ err, messageTs }, "Failed to update approval message");
  }
}
