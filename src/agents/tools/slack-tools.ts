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
