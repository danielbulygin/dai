/**
 * Block Kit action handlers for methodology insight approval/rejection.
 *
 * Registers:
 * - Overflow menu actions on individual insights (approve/reject)
 * - "Approve All" / "Reject All" bulk buttons
 */

import type { App } from "@slack/bolt";
import { logger } from "../../utils/logger.js";
import {
  handleInsightAction,
  handleBulkInsightAction,
  updateApprovalMessage,
} from "../../learning/insight-approval.js";

/** Extract channel + message ts from the action body (works for block_actions) */
function getMessageContext(body: Record<string, unknown>): { channel: string; ts: string } | null {
  const channel = body.channel as { id?: string } | undefined;
  const message = body.message as { ts?: string } | undefined;
  if (channel?.id && message?.ts) {
    return { channel: channel.id, ts: message.ts };
  }
  return null;
}

export function registerInsightActions(app: App): void {
  // Individual insight overflow menu (action_id: insight_action_<uuid>)
  app.action(/^insight_action_/, async ({ action, ack, body }) => {
    await ack();

    if (action.type !== "overflow") return;
    const selectedValue = action.selected_option?.value;
    if (!selectedValue) return;

    // Parse: "approve_<uuid>" or "reject_<uuid>"
    const match = selectedValue.match(/^(approve|reject)_(.+)$/);
    if (!match) return;

    const [, verb, insightId] = match;
    const actionType = verb as "approve" | "reject";

    logger.info({ insightId, action: actionType, user: body.user?.id }, "Insight action received");

    try {
      await handleInsightAction(insightId!, actionType);

      const ctx = getMessageContext(body as unknown as Record<string, unknown>);
      if (ctx) {
        const emoji = actionType === "approve" ? ":white_check_mark:" : ":x:";
        const label = actionType === "approve" ? "Approved" : "Rejected";
        await updateApprovalMessage(
          ctx.channel,
          ctx.ts,
          `${emoji} Insight ${label.toLowerCase()}. Original message updated.`,
        );
      }
    } catch (err) {
      logger.error({ insightId, error: err }, "Failed to handle insight action");
    }
  });

  // Approve All button
  app.action("approve_all_insights", async ({ action, ack, body }) => {
    await ack();

    if (action.type !== "button") return;
    const insightIds = action.value?.split(",") ?? [];

    if (insightIds.length === 0) return;

    logger.info({ count: insightIds.length, user: body.user?.id }, "Approve all insights");

    try {
      const result = await handleBulkInsightAction(insightIds, "approve");

      const ctx = getMessageContext(body as unknown as Record<string, unknown>);
      if (ctx) {
        await updateApprovalMessage(
          ctx.channel,
          ctx.ts,
          `:white_check_mark: *All insights approved* — ${result.approved} saved to methodology knowledge` +
            (result.skipped > 0 ? ` (${result.skipped} already processed)` : ""),
        );
      }
    } catch (err) {
      logger.error({ error: err }, "Failed to approve all insights");
    }
  });

  // Reject All button
  app.action("reject_all_insights", async ({ action, ack, body }) => {
    await ack();

    if (action.type !== "button") return;
    const insightIds = action.value?.split(",") ?? [];

    if (insightIds.length === 0) return;

    logger.info({ count: insightIds.length, user: body.user?.id }, "Reject all insights");

    try {
      const result = await handleBulkInsightAction(insightIds, "reject");

      const ctx = getMessageContext(body as unknown as Record<string, unknown>);
      if (ctx) {
        await updateApprovalMessage(
          ctx.channel,
          ctx.ts,
          `:x: *All insights rejected* — ${result.rejected} discarded` +
            (result.skipped > 0 ? ` (${result.skipped} already processed)` : ""),
        );
      }
    } catch (err) {
      logger.error({ error: err }, "Failed to reject all insights");
    }
  });
}
