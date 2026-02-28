import type { App } from '@slack/bolt';
import { logger } from '../../utils/logger.js';
import { runAgent } from '../../agents/runner.js';
import { getAgent } from '../../agents/registry.js';
import { agentQueue } from '../../orchestrator/queue.js';
import { createStreamResponder } from '../stream-responder.js';

const AGENT_ID = 'jasmin';

function stripMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();
}

export function registerJasminListeners(app: App): void {
  // DMs — all messages go straight to Jasmin
  app.message(async ({ message, client }) => {
    const msg = message as unknown as Record<string, unknown>;

    if (msg.channel_type !== 'im') return;
    if ('bot_id' in message) return;
    if ('subtype' in message) return;

    const text = msg.text as string | undefined;
    const userId = msg.user as string | undefined;
    const messageTs = msg.ts as string | undefined;
    const threadTs = msg.thread_ts as string | undefined;

    if (!text || !userId || !messageTs) return;

    await handleJasminMessage({
      client,
      text,
      userId,
      channel: msg.channel as string,
      messageTs,
      threadTs,
      source: 'DM',
    });
  });

  // Channel @mentions — @Jasmin in any channel
  app.event('app_mention', async ({ event, client }) => {
    const { text, channel, thread_ts, ts } = event;
    const user = event.user ?? 'unknown';

    const authResult = await client.auth.test();
    const botUserId = authResult.user_id as string;
    const cleanedText = stripMention(text, botUserId);

    await handleJasminMessage({
      client,
      text: cleanedText,
      userId: user,
      channel,
      messageTs: ts,
      threadTs: thread_ts,
      source: 'mention',
    });
  });
}

async function handleJasminMessage(opts: {
  client: Parameters<Parameters<App['message']>[0]>[0]['client'];
  text: string;
  userId: string;
  channel: string;
  messageTs: string;
  threadTs: string | undefined;
  source: string;
}): Promise<void> {
  const { client, text, userId, channel, messageTs, threadTs, source } = opts;

  const agent = getAgent(AGENT_ID);
  if (!agent) {
    logger.error('Jasmin agent not found in registry');
    return;
  }

  logger.info(
    { channel, user: userId, agentId: AGENT_ID, source, text },
    `Jasmin ${source} received`,
  );

  const responder = createStreamResponder({
    client,
    channel,
    threadTs: threadTs ?? messageTs,
    userMessageTs: messageTs,
    agentName: agent.config.display_name,
  });

  try {
    const result = await agentQueue.enqueue(channel, () =>
      runAgent({
        agentId: AGENT_ID,
        userMessage: text,
        userId,
        channelId: channel,
        threadTs: threadTs ?? messageTs,
        onText: responder.onText,
      }),
    );

    await responder.finalize(result.response, result.usage);
  } catch (err) {
    logger.error({ err, channel, user: userId }, `Jasmin ${source} agent run failed`);
    await responder.onError(err);
  }
}
