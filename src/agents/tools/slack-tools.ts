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
