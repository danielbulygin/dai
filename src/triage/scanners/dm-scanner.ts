/**
 * DM scanner: detects unanswered Slack DMs and classifies them.
 * Reuses the gatherSlackDMs pattern from briefings.
 * Runs every 5 minutes during work hours.
 */

import { WebClient } from '@slack/web-api';
import { env } from '../../env.js';
import { logger } from '../../utils/logger.js';
import { classifyDm, type DmClassifyInput } from '../classifier.js';
import { upsertTriageItem, resolveBySourceId } from '../queue.js';

// DM channels cache (refreshes every hour)
let dmChannelsCache: { ids: string[]; fetchedAt: number } | null = null;
const DM_CACHE_TTL = 3_600_000;

// User name cache (persists within process lifetime)
const userNameCache = new Map<string, string>();

async function getDmChannelIds(userClient: WebClient): Promise<string[]> {
  if (dmChannelsCache && Date.now() - dmChannelsCache.fetchedAt < DM_CACHE_TTL) {
    return dmChannelsCache.ids;
  }
  const result = await userClient.conversations.list({
    types: 'im',
    limit: 100,
    exclude_archived: true,
  });
  const ids = (result.channels ?? [])
    .map((c) => c.id)
    .filter((id): id is string => Boolean(id));
  dmChannelsCache = { ids, fetchedAt: Date.now() };
  return ids;
}

async function resolveUserName(userClient: WebClient, userId: string): Promise<string> {
  if (userNameCache.has(userId)) return userNameCache.get(userId)!;
  try {
    const info = await userClient.users.info({ user: userId });
    const name = info.user?.real_name ?? info.user?.name ?? userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    userNameCache.set(userId, userId);
    return userId;
  }
}

export async function scanDMs(): Promise<void> {
  try {
    const token = env.SLACK_USER_TOKEN;
    if (!token) {
      logger.debug('Triage DM scan skipped: no SLACK_USER_TOKEN');
      return;
    }

    const userClient = new WebClient(token);
    // Look back 24h for unanswered conversations
    const oldest = String(Math.floor((Date.now() - 24 * 3_600_000) / 1000));

    const dmChannelIds = await getDmChannelIds(userClient);
    if (dmChannelIds.length === 0) return;

    const now = Date.now();
    let classified = 0;
    let resolved = 0;

    const channelResults = await Promise.allSettled(
      dmChannelIds.map(async (channelId) => {
        const history = await userClient.conversations.history({
          channel: channelId,
          oldest,
          limit: 15,
        });
        const messages = (history.messages ?? []).filter(
          (msg) => !msg.bot_id && !msg.subtype && msg.user && msg.ts,
        );
        if (messages.length === 0) return null;

        // Find last message from Daniel vs last from other person
        let lastDanielTs = 0;
        let lastOtherTs = 0;
        let otherUser = '';
        let lastOtherText = '';
        let unansweredCount = 0;

        for (const msg of messages) {
          const ts = parseFloat(msg.ts!);
          if (msg.user === env.SLACK_OWNER_USER_ID) {
            if (ts > lastDanielTs) lastDanielTs = ts;
          } else {
            if (ts > lastOtherTs) {
              lastOtherTs = ts;
              otherUser = msg.user!;
              lastOtherText = msg.text ?? '';
            }
          }
        }

        // If Daniel replied after the last message — auto-resolve any existing triage item
        if (lastOtherTs === 0 || lastDanielTs >= lastOtherTs) {
          await resolveBySourceId(`dm:${channelId}`);
          resolved++;
          return null;
        }

        // Count unanswered messages
        for (const msg of messages) {
          if (msg.user !== env.SLACK_OWNER_USER_ID && parseFloat(msg.ts!) > lastDanielTs) {
            unansweredCount++;
          }
        }

        // Calculate wait time
        const waitMinutes = Math.floor((now / 1000 - lastOtherTs) / 60);

        // Skip if too recent (< 30 min)
        if (waitMinutes < 30) return null;

        const userName = await resolveUserName(userClient, otherUser);

        const input: DmClassifyInput = {
          userId: otherUser,
          userName,
          channelId,
          lastMessageText: lastOtherText,
          waitMinutes,
          unansweredCount,
        };

        const item = classifyDm(input);
        await upsertTriageItem(item);
        classified++;
        return item;
      }),
    );

    // Count errors
    const errors = channelResults.filter((r) => r.status === 'rejected').length;

    logger.info(
      { classified, resolved, errors, channels: dmChannelIds.length },
      'Triage: DM scan complete',
    );
  } catch (err) {
    logger.error({ err }, 'Triage DM scan failed');
  }
}
