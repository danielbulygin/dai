import type { App } from '@slack/bolt';
import { logger } from '../../utils/logger.js';
import { runAgent } from '../../agents/runner.js';
import { agentQueue } from '../../orchestrator/queue.js';
import { chunkMessage, markdownToMrkdwn } from '../formatters/index.js';

export function registerMessageListener(app: App): void {
  app.message(async ({ message, client }) => {
    // Only handle DMs (im channel type)
    if (message.channel_type !== 'im') return;

    // Skip bot messages to avoid loops
    if ('bot_id' in message) return;

    const text = 'text' in message ? message.text : undefined;
    const userId = 'user' in message ? message.user : undefined;

    if (!text || !userId) return;

    logger.info(
      { channel: message.channel, user: userId, text },
      'Received DM',
    );

    // Post a thinking indicator
    const thinkingMsg = await client.chat.postMessage({
      channel: message.channel,
      text: ':hourglass_flowing_sand: Thinking...',
    });

    // DMs always go to Otto (default orchestrator)
    try {
      const result = await agentQueue.enqueue(message.channel, () =>
        runAgent({
          agentId: 'otto',
          userMessage: text,
          userId,
          channelId: message.channel,
        }),
      );

      const mrkdwn = markdownToMrkdwn(result.response);
      const chunks = chunkMessage(mrkdwn);

      if (chunks[0]) {
        await client.chat.update({
          channel: message.channel,
          ts: thinkingMsg.ts as string,
          text: chunks[0],
        });
      }

      for (let i = 1; i < chunks.length; i++) {
        await client.chat.postMessage({
          channel: message.channel,
          text: chunks[i]!,
        });
      }
    } catch (err) {
      logger.error({ err, channel: message.channel, user: userId }, 'Agent run failed');
      await client.chat.update({
        channel: message.channel,
        ts: thinkingMsg.ts as string,
        text: ':x: Sorry, something went wrong. Please try again.',
      });
    }
  });
}
