/**
 * Block Kit action handlers for methodology insight approval/rejection.
 *
 * Registers:
 * - "Approve All" / "Reject All" bulk buttons
 * - Per-type "Approve Rules" / "Reject Rules" etc.
 * - Thread reply listener: "reject 3, 7, 14" / "approve 1-5, 8"
 */

import type { App } from "@slack/bolt";
import { logger } from "../../utils/logger.js";
import { getDaiSupabase } from "../../integrations/dai-supabase.js";
import {
  handleBulkInsightAction,
  handleThreadReply,
  handleFeedbackItems,
  isInsightThread,
  interpretFeedbackWithLLM,
  parseFeedbackReply,
  updateApprovalMessage,
} from "../../learning/insight-approval.js";

/** Extract channel + message ts from the action body */
function getMessageContext(body: Record<string, unknown>): { channel: string; ts: string } | null {
  const channel = body.channel as { id?: string } | undefined;
  const message = body.message as { ts?: string } | undefined;
  if (channel?.id && message?.ts) {
    return { channel: channel.id, ts: message.ts };
  }
  return null;
}

/** Resolve button value to pending insight IDs.
 *  Formats: "meeting:<id>" or "meeting:<id>:<type>" */
async function resolveInsightIds(value: string): Promise<string[]> {
  const supabase = getDaiSupabase();

  if (value.startsWith("meeting:")) {
    const parts = value.split(":");
    const meetingId = parts[1]!;
    const type = parts[2]; // optional type filter

    let query = supabase
      .from("pending_insights")
      .select("id")
      .eq("meeting_id", meetingId)
      .eq("status", "pending");

    if (type) {
      query = query.eq("type", type);
    }

    const { data } = await query;
    return (data ?? []).map((r: { id: string }) => r.id);
  }

  return value.split(",").filter(Boolean);
}

export function registerInsightActions(app: App): void {
  // Approve All
  app.action("approve_all_insights", async ({ action, ack, body }) => {
    await ack();
    if (action.type !== "button") return;

    const ids = await resolveInsightIds(action.value ?? "");
    if (ids.length === 0) return;

    logger.info({ count: ids.length, user: body.user?.id }, "Approve all insights");

    const result = await handleBulkInsightAction(ids, "approve");
    const ctx = getMessageContext(body as unknown as Record<string, unknown>);
    if (ctx) {
      await updateApprovalMessage(
        ctx.channel,
        ctx.ts,
        `:white_check_mark: *All insights approved* — ${result.approved} saved to methodology knowledge` +
          (result.skipped > 0 ? ` (${result.skipped} already processed)` : ""),
      );
    }
  });

  // Reject All
  app.action("reject_all_insights", async ({ action, ack, body }) => {
    await ack();
    if (action.type !== "button") return;

    const ids = await resolveInsightIds(action.value ?? "");
    if (ids.length === 0) return;

    logger.info({ count: ids.length, user: body.user?.id }, "Reject all insights");

    const result = await handleBulkInsightAction(ids, "reject");
    const ctx = getMessageContext(body as unknown as Record<string, unknown>);
    if (ctx) {
      await updateApprovalMessage(
        ctx.channel,
        ctx.ts,
        `:x: *All insights rejected* — ${result.rejected} discarded` +
          (result.skipped > 0 ? ` (${result.skipped} already processed)` : ""),
      );
    }
  });

  // Per-type Approve (approve_type_rule, approve_type_insight, etc.)
  app.action(/^approve_type_/, async ({ action, ack, body }) => {
    await ack();
    if (action.type !== "button") return;

    const ids = await resolveInsightIds(action.value ?? "");
    if (ids.length === 0) return;

    const typeName = ("action_id" in action ? action.action_id : "").replace("approve_type_", "");
    logger.info({ type: typeName, count: ids.length, user: body.user?.id }, "Approve type");

    const result = await handleBulkInsightAction(ids, "approve");
    const ctx = getMessageContext(body as unknown as Record<string, unknown>);
    if (ctx) {
      await updateApprovalMessage(
        ctx.channel,
        ctx.ts,
        `:white_check_mark: Approved ${result.approved} *${typeName}* insights` +
          (result.skipped > 0 ? ` (${result.skipped} already processed)` : ""),
      );
    }
  });

  // Per-type Reject
  app.action(/^reject_type_/, async ({ action, ack, body }) => {
    await ack();
    if (action.type !== "button") return;

    const ids = await resolveInsightIds(action.value ?? "");
    if (ids.length === 0) return;

    const typeName = ("action_id" in action ? action.action_id : "").replace("reject_type_", "");
    logger.info({ type: typeName, count: ids.length, user: body.user?.id }, "Reject type");

    const result = await handleBulkInsightAction(ids, "reject");
    const ctx = getMessageContext(body as unknown as Record<string, unknown>);
    if (ctx) {
      await updateApprovalMessage(
        ctx.channel,
        ctx.ts,
        `:x: Rejected ${result.rejected} *${typeName}* insights` +
          (result.skipped > 0 ? ` (${result.skipped} already processed)` : ""),
      );
    }
  });

  // Thread reply listener — handles all replies on insight approval threads:
  // 1. Structured: "reject 3, 7, 14" / "approve 1-5, 8"
  // 2. Natural language: "15 is situational", "4 - sometimes true"
  // 3. LLM fallback: anything else gets interpreted by Haiku
  app.message(async ({ message, say }) => {
    // Only handle threaded replies
    if (!("thread_ts" in message) || !message.thread_ts) return;
    if (!("text" in message) || !message.text) return;
    // Skip bot messages
    if ("bot_id" in message) return;

    const threadTs = message.thread_ts;
    const text = message.text;

    // Check if this thread belongs to an insight approval message
    const isInsight = await isInsightThread(threadTs);
    if (!isInsight) return;

    // 1. Try structured command: "approve 1-5" / "reject 3, 7"
    const structuredResult = await handleThreadReply(threadTs, text);
    if (structuredResult) {
      await say({ text: structuredResult, thread_ts: threadTs });
      return;
    }

    // 2. Try natural language patterns: "15 is situational", "4 - reason"
    const feedbackItems = parseFeedbackReply(text);
    if (feedbackItems.length > 0) {
      const feedbackResult = await handleFeedbackItems(threadTs, feedbackItems);
      await say({ text: feedbackResult, thread_ts: threadTs });
      return;
    }

    // 3. LLM fallback: ask Haiku to interpret
    try {
      const llmResult = await interpretFeedbackWithLLM(threadTs, text);
      if (llmResult) {
        await say({ text: llmResult, thread_ts: threadTs });
        return;
      }
    } catch (err) {
      logger.error({ err, threadTs }, "LLM feedback interpretation failed");
    }

    // Nothing matched — post help
    await say({
      text: [
        "I couldn't interpret that feedback. Try:",
        "\u2022 `reject 3, 7, 14` \u2014 reject by number",
        "\u2022 `15 is situational` \u2014 reject as situational",
        "\u2022 `19 is a duplicate of 13` \u2014 reject as duplicate",
        "\u2022 `4 - your note here` \u2014 reject with reason",
      ].join("\n"),
      thread_ts: threadTs,
    });
  });
}
