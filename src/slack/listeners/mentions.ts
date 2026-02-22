import type { App } from '@slack/bolt';
import { logger } from '../../utils/logger.js';
import { routeMessage } from '../../orchestrator/router.js';
import { runAgent } from '../../agents/runner.js';
import { agentQueue } from '../../orchestrator/queue.js';
import { chunkMessage, markdownToMrkdwn } from '../formatters/index.js';

export function registerMentionListener(app: App): void {
  app.event('app_mention', async ({ event, client }) => {
    const { text, channel, thread_ts, ts } = event;
    const user = event.user ?? 'unknown';
    const threadTs = thread_ts ?? ts;

    // Get bot user ID for stripping @mention
    const authResult = await client.auth.test();
    const botUserId = authResult.user_id as string;

    // Route to the correct agent
    const route = routeMessage(text, botUserId);

    logger.info(
      { channel, user, agentId: route.agentId, text: route.cleanedText },
      'Received app_mention',
    );

    // Post a thinking indicator
    const thinkingMsg = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: ':hourglass_flowing_sand: Thinking...',
    });

    // Run the agent through the queue
    try {
      const result = await agentQueue.enqueue(channel, () =>
        runAgent({
          agentId: route.agentId,
          userMessage: route.cleanedText,
          userId: user,
          channelId: channel,
          threadTs,
        }),
      );

      // Convert markdown to Slack mrkdwn and chunk if needed
      const mrkdwn = markdownToMrkdwn(result.response);
      const chunks = chunkMessage(mrkdwn);

      // Update the thinking message with the first chunk
      if (chunks[0]) {
        await client.chat.update({
          channel,
          ts: thinkingMsg.ts as string,
          text: chunks[0],
        });
      }

      // Post remaining chunks as follow-up messages
      for (let i = 1; i < chunks.length; i++) {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: chunks[i]!,
        });
      }
    } catch (err) {
      logger.error({ err, channel, user }, 'Agent run failed');
      await client.chat.update({
        channel,
        ts: thinkingMsg.ts as string,
        text: ':x: Sorry, something went wrong. Please try again.',
      });
    }
  });
}
