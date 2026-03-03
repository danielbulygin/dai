/**
 * Triage dispatcher: delivers notifications based on priority tier.
 *
 * P0: Immediately (even in meetings)
 * P1: Within 2 min if not in meeting
 * P2: Batched every 2h during work hours
 * P3: Skip (consumed by briefings)
 *
 * Runs every 2 minutes, 24/7 (P0 can arrive anytime).
 */

import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { getDedicatedBotClient } from '../slack/dedicated-bots.js';
import {
  getPendingItems,
  updateItemStatus,
  batchUpdateStatus,
  unsnoozeExpiredItems,
  expireOldItems,
} from './queue.js';
import {
  type TriageQueueRow,
  SNOOZE_DURATION_MIN,
  P2_BATCH_INTERVAL_HOURS,
  MAX_AGE_HOURS,
} from './index.js';

// ---------------------------------------------------------------------------
// Meeting awareness (cached)
// ---------------------------------------------------------------------------

let meetingCache: { inMeeting: boolean; checkedAt: number } | null = null;
const MEETING_CACHE_TTL = 5 * 60 * 1000;

async function isDanielInMeeting(): Promise<boolean> {
  if (meetingCache && Date.now() - meetingCache.checkedAt < MEETING_CACHE_TTL) {
    return meetingCache.inMeeting;
  }

  try {
    const { checkAvailability } = await import('../agents/tools/google-tools.js');
    const now = new Date();
    const soon = new Date(now.getTime() + 5 * 60_000);
    const result = JSON.parse(
      await checkAvailability({
        startTime: now.toISOString(),
        endTime: soon.toISOString(),
      }),
    ) as { isFree: boolean };

    const inMeeting = !result.isFree;
    meetingCache = { inMeeting, checkedAt: Date.now() };
    return inMeeting;
  } catch (err) {
    logger.debug({ err }, 'Meeting check failed, assuming not in meeting');
    meetingCache = { inMeeting: false, checkedAt: Date.now() };
    return false;
  }
}

// ---------------------------------------------------------------------------
// P2 batch tracking
// ---------------------------------------------------------------------------

let lastP2BatchAt = 0;

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function dispatchNotifications(): Promise<void> {
  try {
    // 1. Un-snooze expired items
    const unsnoozed = await unsnoozeExpiredItems();
    if (unsnoozed > 0) {
      logger.info({ unsnoozed }, 'Triage: un-snoozed items');
    }

    // 2. Get all pending items (P0-P2, skip P3)
    const items = await getPendingItems(2);
    if (items.length === 0) {
      // Still run cleanup even if nothing pending
      await expireOldItems(MAX_AGE_HOURS);
      return;
    }

    // 3. Check meeting status
    const inMeeting = await isDanielInMeeting();

    // 4. Group by priority
    const p0 = items.filter((i) => i.priority_num === 0);
    const p1 = items.filter((i) => i.priority_num === 1);
    const p2 = items.filter((i) => i.priority_num === 2);

    // 5. P0: notify immediately
    for (const item of p0) {
      await sendIndividualAlert(item);
    }

    // 6. P1: notify if not in meeting
    if (!inMeeting) {
      for (const item of p1) {
        await sendIndividualAlert(item);
      }
    } else if (p1.length > 0) {
      logger.debug({ count: p1.length }, 'Triage: P1 items deferred (in meeting)');
    }

    // 7. P2: batch every 2h
    const hoursSinceLastBatch = (Date.now() - lastP2BatchAt) / 3_600_000;
    if (p2.length > 0 && hoursSinceLastBatch >= P2_BATCH_INTERVAL_HOURS) {
      await sendBatchDigest(p2);
      lastP2BatchAt = Date.now();
    }

    // 8. Expire old items
    const expired = await expireOldItems(MAX_AGE_HOURS);
    if (expired > 0) {
      logger.info({ expired }, 'Triage: expired old items');
    }
  } catch (err) {
    logger.error({ err }, 'Triage dispatch failed');
  }
}

// ---------------------------------------------------------------------------
// Individual alert (P0/P1)
// ---------------------------------------------------------------------------

async function sendIndividualAlert(item: TriageQueueRow): Promise<void> {
  const emoji = item.priority_num === 0 ? ':rotating_light:' : ':warning:';
  const sourceEmoji = item.source === 'email' ? ':email:' : ':speech_balloon:';

  const blocks = [
    {
      type: 'section' as const,
      text: {
        type: 'mrkdwn' as const,
        text: `${emoji} *${item.title}*\n${item.preview ? `"${item.preview}"` : ''}\n${sourceEmoji} ${item.reason} | ${item.source} | ${item.priority}`,
      },
    },
    {
      type: 'actions' as const,
      elements: [
        {
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: 'On it' },
          style: 'primary' as const,
          action_id: 'triage_ack',
          value: item.id,
        },
        {
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: `Snooze ${SNOOZE_DURATION_MIN}m` },
          action_id: 'triage_snooze',
          value: item.id,
        },
        {
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: 'Dismiss' },
          action_id: 'triage_dismiss',
          value: item.id,
        },
      ],
    },
  ];

  try {
    const client = getDedicatedBotClient('jasmin');
    const result = await client.chat.postMessage({
      channel: env.SLACK_OWNER_USER_ID,
      text: `${emoji} ${item.title} — ${item.reason}`,
      blocks,
    });

    await updateItemStatus(item.id, 'notified', {
      notified_at: new Date().toISOString(),
      notification_ts: result.ts ?? null,
    });

    logger.info(
      { id: item.id, priority: item.priority, title: item.title },
      'Triage: sent individual alert',
    );
  } catch (err) {
    logger.error({ err, id: item.id }, 'Triage: failed to send alert');
  }
}

// ---------------------------------------------------------------------------
// Batch digest (P2)
// ---------------------------------------------------------------------------

async function sendBatchDigest(items: TriageQueueRow[]): Promise<void> {
  const lines = items.map((item) => {
    const emoji = item.source === 'email' ? ':email:' : ':speech_balloon:';
    const wait = item.reason ?? '';
    return `${emoji} ${item.title} — ${wait}`;
  });

  const blocks = [
    {
      type: 'section' as const,
      text: {
        type: 'mrkdwn' as const,
        text: `:clipboard: *Triage Digest* (${items.length} items needing attention)\n\n${lines.join('\n')}`,
      },
    },
    {
      type: 'actions' as const,
      elements: [
        {
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: 'Mark All Handled' },
          style: 'primary' as const,
          action_id: 'triage_batch_ack',
          value: items.map((i) => i.id).join(','),
        },
      ],
    },
  ];

  try {
    const client = getDedicatedBotClient('jasmin');
    const result = await client.chat.postMessage({
      channel: env.SLACK_OWNER_USER_ID,
      text: `:clipboard: Triage Digest — ${items.length} items needing attention`,
      blocks,
    });

    // Mark all as notified
    const ids = items.map((i) => i.id);
    await batchUpdateStatus(ids, 'notified');

    // Store notification_ts on first item for reference
    if (items[0] && result.ts) {
      await updateItemStatus(items[0].id, 'notified', {
        notification_ts: result.ts,
      });
    }

    logger.info({ count: items.length }, 'Triage: sent batch digest');
  } catch (err) {
    logger.error({ err, count: items.length }, 'Triage: failed to send batch digest');
  }
}
