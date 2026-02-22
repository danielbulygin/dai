import type { App } from '@slack/bolt';
import { logger } from '../../utils/logger.js';
import { routeMessage } from '../../orchestrator/router.js';
import { runAgent } from '../../agents/runner.js';
import { getAgent, getDefaultAgent } from '../../agents/registry.js';
import { agentQueue } from '../../orchestrator/queue.js';
import { createStreamResponder } from '../stream-responder.js';

export function registerMessageListener(app: App): void {
  app.message(async ({ message, client }) => {
    // Handle DMs and private channels (group)
    const channelType = message.channel_type;
    if (channelType !== 'im' && channelType !== 'group') return;

    // Skip bot messages to avoid loops
    if ('bot_id' in message) return;
    // Also skip message subtypes (edits, joins, etc.)
    if ('subtype' in message) return;

    const text = 'text' in message ? message.text : undefined;
    const userId = 'user' in message ? message.user : undefined;
    const messageTs = 'ts' in message ? (message.ts as string) : undefined;
    const threadTs = 'thread_ts' in message ? (message.thread_ts as string | undefined) : undefined;

    if (!text || !userId || !messageTs) return;

    let agentId: string;
    let cleanedText: string;
    let agentName: string;

    if (channelType === 'im') {
      // DMs always go to Otto
      agentId = 'otto';
      cleanedText = text;
      agentName = 'Otto';

      logger.info(
        { channel: message.channel, user: userId, text },
        'Received DM',
      );
    } else {
      // Private channel: route through the agent router
      const authResult = await client.auth.test();
      const botUserId = authResult.user_id as string;

      const route = routeMessage(text, botUserId);
      agentId = route.agentId;
      cleanedText = route.cleanedText;

      const agent = getAgent(agentId) ?? getDefaultAgent();
      agentName = agent.config.display_name;

      logger.info(
        { channel: message.channel, user: userId, agentId, text: cleanedText },
        'Received channel message',
      );
    }

    // Set up the streaming responder
    const responder = createStreamResponder({
      client,
      channel: message.channel,
      threadTs: threadTs ?? messageTs,
      userMessageTs: messageTs,
      agentName,
    });

    try {
      const result = await agentQueue.enqueue(message.channel, () =>
        runAgent({
          agentId,
          userMessage: cleanedText,
          userId,
          channelId: message.channel,
          threadTs: threadTs ?? messageTs,
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
