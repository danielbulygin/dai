/**
 * Block Kit action handlers for triage notifications.
 * Handles: On it, Snooze, Dismiss, Mark All Handled.
 */

import type { App } from '@slack/bolt';
import { logger } from '../../utils/logger.js';
import { updateItemStatus, batchUpdateStatus } from '../../triage/queue.js';
import { SNOOZE_DURATION_MIN } from '../../triage/index.js';

function getMessageContext(body: Record<string, unknown>): { channel: string; ts: string } | null {
  const channel = body.channel as { id?: string } | undefined;
  const message = body.message as { ts?: string } | undefined;
  if (channel?.id && message?.ts) {
    return { channel: channel.id, ts: message.ts };
  }
  return null;
}

async function updateMessage(
  client: { chat: { update: (args: Record<string, unknown>) => Promise<unknown> } },
  channel: string,
  ts: string,
  text: string,
): Promise<void> {
  try {
    await client.chat.update({
      channel,
      ts,
      text,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text },
        },
      ],
    });
  } catch (err) {
    logger.error({ err }, 'Failed to update triage message');
  }
}

export function registerTriageActions(app: App): void {
  // "On it" — acknowledge single item
  app.action('triage_ack', async ({ action, ack, body, client }) => {
    await ack();
    if (action.type !== 'button') return;

    const itemId = action.value;
    if (!itemId) return;

    logger.info({ itemId }, 'Triage: item acknowledged');
    await updateItemStatus(itemId, 'acknowledged');

    const ctx = getMessageContext(body as unknown as Record<string, unknown>);
    if (ctx) {
      await updateMessage(
        client as unknown as { chat: { update: (args: Record<string, unknown>) => Promise<unknown> } },
        ctx.channel,
        ctx.ts,
        ':white_check_mark: *Got it* — marked as handled',
      );
    }
  });

  // "Snooze" — snooze single item
  app.action('triage_snooze', async ({ action, ack, body, client }) => {
    await ack();
    if (action.type !== 'button') return;

    const itemId = action.value;
    if (!itemId) return;

    const snoozedUntil = new Date(Date.now() + SNOOZE_DURATION_MIN * 60_000).toISOString();

    logger.info({ itemId, snoozedUntil }, 'Triage: item snoozed');
    await updateItemStatus(itemId, 'snoozed', { snoozed_until: snoozedUntil });

    const snoozeTime = new Date(snoozedUntil).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Berlin',
    });

    const ctx = getMessageContext(body as unknown as Record<string, unknown>);
    if (ctx) {
      await updateMessage(
        client as unknown as { chat: { update: (args: Record<string, unknown>) => Promise<unknown> } },
        ctx.channel,
        ctx.ts,
        `:zzz: *Snoozed* until ${snoozeTime}`,
      );
    }
  });

  // "Dismiss" — resolve single item
  app.action('triage_dismiss', async ({ action, ack, body, client }) => {
    await ack();
    if (action.type !== 'button') return;

    const itemId = action.value;
    if (!itemId) return;

    logger.info({ itemId }, 'Triage: item dismissed');
    await updateItemStatus(itemId, 'resolved');

    const ctx = getMessageContext(body as unknown as Record<string, unknown>);
    if (ctx) {
      await updateMessage(
        client as unknown as { chat: { update: (args: Record<string, unknown>) => Promise<unknown> } },
        ctx.channel,
        ctx.ts,
        ':no_entry_sign: *Dismissed*',
      );
    }
  });

  // "Mark All Handled" — batch acknowledge
  app.action('triage_batch_ack', async ({ action, ack, body, client }) => {
    await ack();
    if (action.type !== 'button') return;

    const ids = (action.value ?? '').split(',').filter(Boolean);
    if (ids.length === 0) return;

    logger.info({ count: ids.length }, 'Triage: batch acknowledged');
    await batchUpdateStatus(ids, 'acknowledged');

    const ctx = getMessageContext(body as unknown as Record<string, unknown>);
    if (ctx) {
      await updateMessage(
        client as unknown as { chat: { update: (args: Record<string, unknown>) => Promise<unknown> } },
        ctx.channel,
        ctx.ts,
        `:white_check_mark: *All ${ids.length} items marked as handled*`,
      );
    }
  });
}
