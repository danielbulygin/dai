#!/usr/bin/env npx tsx
/**
 * Re-sends pending durable insights to Slack for approval.
 * Usage: pnpm tsx scripts/resend-pending-insights.ts
 */

import { createClient } from "@supabase/supabase-js";
import { WebClient } from "@slack/web-api";

const url = process.env.DAI_SUPABASE_URL!;
const key = process.env.DAI_SUPABASE_SERVICE_KEY!;
const supabase = createClient(url, key);

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const channel = process.env.SLACK_REVIEW_CHANNEL_ID ?? process.env.SLACK_OWNER_USER_ID!;

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

async function main() {
  // Fetch all pending durable insights
  const { data: rows, error } = await supabase
    .from("pending_insights")
    .select("id, seq, type, title, account_code, category, confidence, body, meeting_id, meeting_title, meeting_date")
    .eq("status", "pending")
    .order("seq", { ascending: true });

  if (error) {
    console.error("Error fetching pending insights:", error);
    process.exit(1);
  }

  if (!rows || rows.length === 0) {
    console.log("No pending insights to send.");
    process.exit(0);
  }

  const meetingId = rows[0].meeting_id;
  const meetingTitle = rows[0].meeting_title;
  const meetingDate = rows[0].meeting_date;

  console.log(`Re-sending ${rows.length} pending insights from "${meetingTitle}" (${meetingDate})`);

  // Build Block Kit message
  const blocks: Array<Record<string, unknown>> = [];

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `Insights: ${meetingTitle}`, emoji: true },
  });

  blocks.push({
    type: "context",
    elements: [{
      type: "mrkdwn",
      text: `${meetingDate} | ${rows.length} insights | Reply in thread to cherry-pick`,
    }],
  });

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
  const grouped = new Map<string, typeof rows>();
  for (const ins of rows) {
    const group = grouped.get(ins.type) ?? [];
    group.push(ins);
    grouped.set(ins.type, group);
  }

  const MAX_SECTION_CHARS = 2900;

  for (const [type, items] of grouped) {
    const emoji = TYPE_EMOJI[type] ?? ":bulb:";
    const label = TYPE_LABELS[type] ?? type;

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

    const bullets = items.map((item) => {
      const acct = item.account_code ? ` \`${item.account_code}\`` : "";
      return `*${item.seq}.* ${item.title}${acct}`;
    });

    let currentChunk: string[] = [];
    let currentLen = 0;
    let chunkIndex = 0;

    for (const bullet of bullets) {
      if (currentLen + bullet.length + 1 > MAX_SECTION_CHARS && currentChunk.length > 0) {
        const header = chunkIndex === 0 ? `${emoji} *${label}s* (${items.length})\n` : "";
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
      const header = chunkIndex === 0 ? `${emoji} *${label}s* (${items.length})\n` : "";
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: header + currentChunk.join("\n") },
      });
    }

    blocks.push({ type: "divider" });
  }

  // Check for auto_saved situational insights from same meeting
  const { count: sitCount } = await supabase
    .from("pending_insights")
    .select("id", { count: "exact", head: true })
    .eq("meeting_id", meetingId)
    .eq("status", "auto_saved");

  if (sitCount && sitCount > 0) {
    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `_${sitCount} situational observations were auto-saved earlier_`,
      }],
    });
  }

  // Post to Slack
  const result = await slack.chat.postMessage({
    channel,
    blocks: blocks as any,
    text: `${rows.length} methodology insights from "${meetingTitle}" — review and approve/reject`,
  });

  console.log(`Posted to ${channel}, ts: ${result.ts}`);

  // Update slack_message_ts on pending rows
  if (result.ts) {
    const ids = rows.map((r) => r.id);
    const { error: updateError } = await supabase
      .from("pending_insights")
      .update({ slack_message_ts: result.ts })
      .in("id", ids);

    if (updateError) {
      console.error("Failed to update slack_message_ts:", updateError);
    } else {
      console.log(`Updated slack_message_ts on ${ids.length} rows`);
    }

    // Post helper message in thread
    await slack.chat.postMessage({
      channel,
      thread_ts: result.ts,
      text: [
        "Reply in this thread to cherry-pick:",
        "`reject 3, 7, 14` — reject specific items by number",
        "`approve 1-5, 8` — approve a range + individual",
        "`reject all decisions` — reject an entire type",
        "Or just type natural language: `15 is situational`, `19 is a duplicate of 13`",
        "Buttons above handle bulk approve/reject by type or all at once.",
      ].join("\n"),
    });

    console.log("Posted helper thread message");
  }

  console.log("Done!");
}

main().catch(console.error);
