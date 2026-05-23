/**
 * Block Kit action handlers for Ada's ad launch approval flow (Phase 11).
 *
 * When Ada calls previewAdLaunch (BMAD /api/ada/preview-launch), she should post
 * a Block Kit message in the thread with these buttons:
 *   - "Launch N ads"  (action_id: "ada_launch_batch")
 *   - "Edit landers"  (action_id: "ada_edit_landers")
 *   - "Edit copy"     (action_id: "ada_edit_copy")
 *   - "Cancel"        (action_id: "ada_cancel_batch")
 *
 * Each button's `value` is the batch_id (uuid). The action handlers below decode
 * that and call the appropriate ad-launch-tools function.
 *
 * For "pause" / "undo" — handled in reactions.ts (⏸ emoji on a launched batch
 * message) or by posting a "pause <batch_id_prefix>" reply in-thread. See
 * registerLaunchReplyListener below.
 *
 * Modal handlers for Edit Landers / Edit Copy are stubbed for now — they post an
 * ephemeral message explaining how to override via thread reply. Full Slack View
 * Submission handlers can be added by following the pattern in insight-actions.ts.
 */

import type { App } from "@slack/bolt";
import { logger } from "../../utils/logger.js";
import {
  launchAds,
  pauseLaunch,
} from "../../agents/tools/ad-launch-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MessageContext {
  channel: string;
  ts: string;
  user: string;
}

function getMessageContext(body: Record<string, unknown>): MessageContext | null {
  const channel = body.channel as { id?: string } | undefined;
  const message = body.message as { ts?: string } | undefined;
  const user = body.user as { id?: string } | undefined;
  if (channel?.id && message?.ts && user?.id) {
    return { channel: channel.id, ts: message.ts, user: user.id };
  }
  return null;
}

/** Stable idempotency key derived from a button click — survives Slack retries.
 *  Format: ada_launch:<batch_id>:<click_ts> */
function idempotencyKeyFromClick(batchId: string, actionTs: string): string {
  return `ada_launch:${batchId}:${actionTs}`;
}

/** Post or update the original preview message to show the result. */
async function updateMessage(
  app: App,
  channel: string,
  ts: string,
  text: string,
  blocks?: unknown[],
): Promise<void> {
  try {
    await app.client.chat.update({
      channel,
      ts,
      text,
      blocks: blocks as never,
    });
  } catch (err) {
    logger.error({ err, channel, ts }, "Failed to update launch preview message");
  }
}

async function postReply(
  app: App,
  channel: string,
  thread_ts: string,
  text: string,
  ephemeral_user?: string,
): Promise<void> {
  try {
    if (ephemeral_user) {
      await app.client.chat.postEphemeral({ channel, thread_ts, text, user: ephemeral_user });
    } else {
      await app.client.chat.postMessage({ channel, thread_ts, text });
    }
  } catch (err) {
    logger.error({ err }, "Failed to post Slack reply");
  }
}

// ---------------------------------------------------------------------------
// Public registration
// ---------------------------------------------------------------------------

export function registerLaunchActions(app: App): void {
  // -----------------------------------------------------------------------
  // Launch button → call launchAds
  // -----------------------------------------------------------------------
  app.action("ada_launch_batch", async ({ action, ack, body }) => {
    await ack();
    if (action.type !== "button") return;
    const batchId = action.value;
    const ctx = getMessageContext(body as unknown as Record<string, unknown>);
    if (!batchId || !ctx) return;

    logger.info({ batchId, user: ctx.user }, "Ada launch button clicked");

    // Idempotency key derived from this click — Slack retry of the same button
    // click reproduces the same key, so the droplet returns the original result.
    const idempotencyKey = idempotencyKeyFromClick(batchId, (action as { action_ts?: string }).action_ts ?? ctx.ts);

    const resultJson = await launchAds({ batch_id: batchId, idempotency_key: idempotencyKey });
    let result: Record<string, unknown> = {};
    try { result = JSON.parse(resultJson); } catch { /* keep empty */ }

    if (result.error) {
      await updateMessage(app, ctx.channel, ctx.ts,
        `:x: Launch failed — ${result.error}`);
      return;
    }

    const adIds = (result.ad_ids ?? []) as string[];
    const adsManagerUrl = result.ads_manager_url ?? "";
    const status = result.status ?? "unknown";
    const failures = (result.failures ?? []) as Array<{ video_id: string; reason: string }>;
    const idempotentReplay = result.idempotent_replay === true;

    const lines = [
      `:rocket: *Launched batch* \`${batchId.slice(0, 8)}\`${idempotentReplay ? " _(replay — no duplicate ads created)_" : ""}`,
      `Status: \`${status}\` · ${adIds.length} ad${adIds.length === 1 ? "" : "s"} created PAUSED`,
      adsManagerUrl ? `<${adsManagerUrl}|Open in Ads Manager>` : "",
    ];
    if (failures.length > 0) {
      lines.push("");
      lines.push("⚠️ Failures:");
      for (const f of failures) {
        lines.push(`  • ${f.video_id}: ${f.reason}`);
      }
    }
    lines.push("");
    lines.push("_To pause this batch, reply with `pause " + batchId.slice(0, 8) + "` or react ⏸️ to this message._");
    await updateMessage(app, ctx.channel, ctx.ts, lines.filter(Boolean).join("\n"));
  });

  // -----------------------------------------------------------------------
  // Cancel button → mark the preview cancelled (no Meta calls; just update msg)
  // -----------------------------------------------------------------------
  app.action("ada_cancel_batch", async ({ action, ack, body }) => {
    await ack();
    if (action.type !== "button") return;
    const batchId = action.value;
    const ctx = getMessageContext(body as unknown as Record<string, unknown>);
    if (!batchId || !ctx) return;

    logger.info({ batchId, user: ctx.user }, "Ada launch cancelled");

    // We don't have an /api/ada/cancel-preview endpoint — the launch_batches row
    // stays in 'pending' status. That's fine: a stale pending batch is harmless
    // (no Meta side effects), and the daily cleanup cron can sweep them.
    // If you want explicit cancellation status, add /api/ada/cancel-batch later.
    await updateMessage(app, ctx.channel, ctx.ts,
      `:x: Launch cancelled by <@${ctx.user}> — batch \`${batchId.slice(0, 8)}\` left as pending.`);
  });

  // -----------------------------------------------------------------------
  // Edit landers / copy — stubbed. Post ephemeral with manual-override instructions.
  // (Full Slack View Submission modal handlers should be added here when desired.)
  // -----------------------------------------------------------------------
  app.action("ada_edit_landers", async ({ ack, body }) => {
    await ack();
    const ctx = getMessageContext(body as unknown as Record<string, unknown>);
    if (!ctx) return;
    await postReply(
      app, ctx.channel, ctx.ts,
      "_Lander override modal not yet implemented._ For now, reply with a manual override " +
      "and I'll relaunch — e.g. `relaunch <batch_id> override <video_id> https://new-url.com`.",
      ctx.user,
    );
  });

  app.action("ada_edit_copy", async ({ ack, body }) => {
    await ack();
    const ctx = getMessageContext(body as unknown as Record<string, unknown>);
    if (!ctx) return;
    await postReply(
      app, ctx.channel, ctx.ts,
      "_Copy override modal not yet implemented._ Reply with a manual override and I'll relaunch.",
      ctx.user,
    );
  });
}

// ---------------------------------------------------------------------------
// Pause thread-reply handler
// Wire this from messages.ts or as a standalone listener — call from wherever
// thread replies in launch threads are processed.
// ---------------------------------------------------------------------------

const PAUSE_REPLY_RE = /^\s*(pause|undo)\s+([0-9a-f]{8})/i;

/**
 * Inspect a thread reply for "pause <batch_id_prefix>" or "undo <batch_id_prefix>".
 * Returns the matched batch_id_prefix or null. Caller resolves to the full batch_id
 * (via a launch_batches lookup) and calls pauseLaunch.
 */
export function parsePauseReply(text: string): string | null {
  const match = PAUSE_REPLY_RE.exec(text);
  return match ? match[2]?.toLowerCase() ?? null : null;
}

/**
 * Call pauseLaunch with a known batch_id. Used by the message-listener pause handler
 * once it has resolved the full batch_id from a user-typed 8-char prefix.
 */
export async function handlePauseRequest(params: {
  batch_id: string;
  reason: string;
}): Promise<{ success: boolean; message: string }> {
  const resultJson = await pauseLaunch({ batch_id: params.batch_id, reason: params.reason });
  let result: Record<string, unknown> = {};
  try { result = JSON.parse(resultJson); } catch { /* */ }

  if (result.error) {
    return { success: false, message: `Pause failed — ${result.error}` };
  }
  const failures = (result.failures ?? []) as Array<unknown>;
  if (failures.length > 0) {
    return {
      success: false,
      message: `Partial pause — ${failures.length} object(s) failed. Check Ads Manager.`,
    };
  }
  return {
    success: true,
    message: `:pause_button: Batch \`${params.batch_id.slice(0, 8)}\` paused.`,
  };
}
