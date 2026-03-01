import { WebClient } from "@slack/web-api";
import { env } from "../../env.js";
import { logger } from "../../utils/logger.js";

const slack = new WebClient(env.SLACK_BOT_TOKEN);

function getUserClient(): WebClient | null {
  const token = env.SLACK_USER_TOKEN;
  if (!token) return null;
  return new WebClient(token);
}

export async function postMessage(params: {
  channel: string;
  text: string;
  thread_ts?: string;
}): Promise<{ ok: boolean; ts?: string }> {
  try {
    const result = await slack.chat.postMessage({
      channel: params.channel,
      text: params.text,
      thread_ts: params.thread_ts,
    });

    logger.debug(
      { channel: params.channel, ts: result.ts },
      "Posted message to Slack",
    );

    return { ok: true, ts: result.ts ?? undefined };
  } catch (error) {
    logger.error({ error, channel: params.channel }, "Failed to post message");
    return { ok: false };
  }
}

export async function addReaction(params: {
  channel: string;
  timestamp: string;
  name: string;
}): Promise<{ ok: boolean }> {
  try {
    await slack.reactions.add({
      channel: params.channel,
      timestamp: params.timestamp,
      name: params.name,
    });

    logger.debug(
      { channel: params.channel, name: params.name },
      "Added reaction",
    );

    return { ok: true };
  } catch (error) {
    logger.error({ error, channel: params.channel }, "Failed to add reaction");
    return { ok: false };
  }
}

export async function sendAsDaniel(params: {
  channel: string;
  text: string;
  thread_ts?: string;
}): Promise<{ ok: boolean; ts?: string }> {
  const userClient = getUserClient();
  if (!userClient) {
    logger.error("SLACK_USER_TOKEN not configured — cannot send as Daniel");
    return { ok: false };
  }

  try {
    // Open the DM/channel if needed
    const openResult = await userClient.conversations.open({
      channel: params.channel,
    });
    const channelId = openResult.channel?.id ?? params.channel;

    const result = await userClient.chat.postMessage({
      channel: channelId,
      text: params.text,
      thread_ts: params.thread_ts,
    });

    logger.info(
      { channel: channelId, ts: result.ts },
      "Sent message as Daniel",
    );

    return { ok: true, ts: result.ts ?? undefined };
  } catch (error) {
    logger.error(
      { error, channel: params.channel },
      "Failed to send message as Daniel",
    );
    return { ok: false };
  }
}

export async function readDMs(params: {
  channel: string;
  limit?: number;
}): Promise<{ ok: boolean; messages?: Array<{ user: string; text: string; ts: string }> }> {
  const userClient = getUserClient();
  if (!userClient) {
    logger.error("SLACK_USER_TOKEN not configured — cannot read DMs");
    return { ok: false };
  }

  try {
    const result = await userClient.conversations.history({
      channel: params.channel,
      limit: params.limit ?? 20,
    });

    const messages = (result.messages ?? []).map((m) => ({
      user: m.user ?? "unknown",
      text: m.text ?? "",
      ts: m.ts ?? "",
    }));

    return { ok: true, messages };
  } catch (error) {
    logger.error({ error, channel: params.channel }, "Failed to read DMs");
    return { ok: false };
  }
}

export async function findUser(params: {
  name: string;
}): Promise<{ ok: boolean; users?: Array<{ id: string; name: string; real_name: string; dm_channel?: string }> }> {
  const userClient = getUserClient();
  const client = userClient ?? slack;

  try {
    const query = params.name.toLowerCase();
    const allMatches: Array<{ id: string; name: string; real_name: string; display_name: string }> = [];

    // Paginate through all workspace members
    let cursor: string | undefined;
    do {
      const result = await client.users.list({ limit: 200, cursor });
      const members = result.members ?? [];

      for (const m of members) {
        if (m.deleted || m.is_bot) continue;
        const realName = (m.real_name ?? "").toLowerCase();
        const displayName = (m.profile?.display_name ?? "").toLowerCase();
        const userName = (m.name ?? "").toLowerCase();
        if (
          realName.includes(query) ||
          displayName.includes(query) ||
          userName.includes(query)
        ) {
          allMatches.push({
            id: m.id!,
            name: m.name ?? "",
            real_name: m.real_name ?? "",
            display_name: m.profile?.display_name ?? "",
          });
        }
      }

      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);

    // For each match, try to open a DM channel so Jasmin can use it directly
    const users = [];
    for (const m of allMatches.slice(0, 5)) {
      let dmChannel: string | undefined;
      if (userClient) {
        try {
          const conv = await userClient.conversations.open({ users: m.id });
          dmChannel = conv.channel?.id;
        } catch {
          // Not critical — user can still use the user ID
        }
      }
      users.push({
        id: m.id,
        name: m.name,
        real_name: m.real_name,
        dm_channel: dmChannel,
      });
    }

    logger.debug({ query: params.name, matchCount: users.length }, "Found Slack users");
    return { ok: true, users };
  } catch (error) {
    logger.error({ error, name: params.name }, "Failed to find user");
    return { ok: false };
  }
}

interface UnreadConversation {
  channel_id: string;
  type: "dm" | "group_dm";
  participants: string[];
  unread_count: number;
  messages: Array<{ user: string; text: string; ts: string }>;
}

// Cache user ID → display name to avoid repeated lookups
const userNameCache = new Map<string, string>();

async function resolveUserName(client: WebClient, userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;

  try {
    const result = await client.users.info({ user: userId });
    const name =
      result.user?.profile?.display_name ||
      result.user?.real_name ||
      result.user?.name ||
      userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

export async function getUnreadDMs(params: {
  limit?: number;
}): Promise<{ ok: boolean; conversations?: UnreadConversation[]; total_unread?: number }> {
  const userClient = getUserClient();
  if (!userClient) {
    logger.error("SLACK_USER_TOKEN not configured — cannot check unread DMs");
    return { ok: false };
  }

  try {
    const maxConversations = params.limit ?? 15;
    const unreadConversations: UnreadConversation[] = [];

    // List all DM and group DM channels (im = 1:1, mpim = group)
    let cursor: string | undefined;
    const allChannels: Array<{
      id: string;
      is_im: boolean;
      is_mpim: boolean;
      user?: string;
      unread_count?: number;
      last_read?: string;
      latest?: { ts?: string };
    }> = [];

    do {
      const result = await userClient.conversations.list({
        types: "im,mpim",
        limit: 200,
        cursor,
        exclude_archived: true,
      });

      for (const ch of result.channels ?? []) {
        allChannels.push({
          id: ch.id!,
          is_im: ch.is_im ?? false,
          is_mpim: ch.is_mpim ?? false,
          user: (ch as { user?: string }).user,
          unread_count: (ch as { unread_count?: number }).unread_count,
          last_read: (ch as { last_read?: string }).last_read,
          latest: (ch as { latest?: { ts?: string } }).latest,
        });
      }

      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);

    // Filter to channels with unread messages
    // conversations.list may not always have unread_count, so also check via history
    for (const ch of allChannels) {
      if (unreadConversations.length >= maxConversations) break;

      // Skip channels with no recent activity
      if (!ch.latest?.ts) continue;

      // If unread_count is available and zero, skip
      if (ch.unread_count !== undefined && ch.unread_count === 0) continue;

      // Fetch messages since last_read to get unreads
      try {
        const historyParams: { channel: string; limit: number; oldest?: string } = {
          channel: ch.id,
          limit: 10,
        };
        if (ch.last_read) {
          historyParams.oldest = ch.last_read;
        }

        const history = await userClient.conversations.history(historyParams);
        const messages = (history.messages ?? []).filter(
          (m) => m.user !== env.SLACK_OWNER_USER_ID, // Skip Daniel's own messages
        );

        if (messages.length === 0) continue;

        // Resolve participant names
        const participantIds = new Set<string>();
        for (const m of messages) {
          if (m.user) participantIds.add(m.user);
        }
        if (ch.user) participantIds.add(ch.user);

        const participantNames: string[] = [];
        for (const uid of participantIds) {
          participantNames.push(await resolveUserName(userClient, uid));
        }

        unreadConversations.push({
          channel_id: ch.id,
          type: ch.is_mpim ? "group_dm" : "dm",
          participants: participantNames,
          unread_count: messages.length,
          messages: messages.map((m) => ({
            user: m.user ?? "unknown",
            text: m.text ?? "",
            ts: m.ts ?? "",
          })),
        });
      } catch {
        // Channel might be inaccessible — skip
        continue;
      }
    }

    // Resolve user IDs in messages to names
    for (const conv of unreadConversations) {
      for (const msg of conv.messages) {
        if (msg.user !== "unknown") {
          msg.user = await resolveUserName(userClient, msg.user);
        }
      }
    }

    const totalUnread = unreadConversations.reduce((sum, c) => sum + c.unread_count, 0);

    logger.info(
      { conversationCount: unreadConversations.length, totalUnread },
      "Fetched unread DMs",
    );

    return { ok: true, conversations: unreadConversations, total_unread: totalUnread };
  } catch (error) {
    logger.error({ error }, "Failed to get unread DMs");
    return { ok: false };
  }
}

export async function replyInThread(params: {
  channel: string;
  thread_ts: string;
  text: string;
}): Promise<{ ok: boolean; ts?: string }> {
  try {
    const result = await slack.chat.postMessage({
      channel: params.channel,
      text: params.text,
      thread_ts: params.thread_ts,
    });

    logger.debug(
      { channel: params.channel, thread_ts: params.thread_ts, ts: result.ts },
      "Replied in thread",
    );

    return { ok: true, ts: result.ts ?? undefined };
  } catch (error) {
    logger.error(
      { error, channel: params.channel, thread_ts: params.thread_ts },
      "Failed to reply in thread",
    );
    return { ok: false };
  }
}
