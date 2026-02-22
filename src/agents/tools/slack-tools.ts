import { WebClient } from "@slack/web-api";
import { env } from "../../env.js";
import { logger } from "../../utils/logger.js";

const slack = new WebClient(env.SLACK_BOT_TOKEN);

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
