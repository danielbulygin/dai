import type { App } from '@slack/bolt';
import { logger } from '../../utils/logger.js';
import { runAgent } from '../../agents/runner.js';
import { agentQueue } from '../../orchestrator/queue.js';
import { createStreamResponder } from '../stream-responder.js';

export function registerMessageListener(app: App): void {
  app.message(async ({ message, client }) => {
    // Only handle DMs (im channel type)
    if (message.channel_type !== 'im') return;

    // Skip bot messages to avoid loops
    if ('bot_id' in message) return;

    const text = 'text' in message ? message.text : undefined;
    const userId = 'user' in message ? message.user : undefined;
    const messageTs = 'ts' in message ? (message.ts as string) : undefined;

    if (!text || !userId || !messageTs) return;

    logger.info(
      { channel: message.channel, user: userId, text },
      'Received DM',
    );

    // DMs always go to Otto
    const agentName = 'Otto';

    // Set up the streaming responder
    const responder = createStreamResponder({
      client,
      channel: message.channel,
      userMessageTs: messageTs,
      agentName,
    });

    try {
      const result = await agentQueue.enqueue(message.channel, () =>
        runAgent({
          agentId: 'otto',
          userMessage: text,
          userId,
          channelId: message.channel,
          onText: responder.onText,
        }),
      );

      await responder.finalize(result.response, result.usage);
    } catch (err) {
      logger.error({ err, channel: message.channel, user: userId }, 'Agent run failed');
      await responder.onError(err);
    }
  });
}
