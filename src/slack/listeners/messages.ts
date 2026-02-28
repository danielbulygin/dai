import type { App } from '@slack/bolt';
import { logger } from '../../utils/logger.js';
import { routeMessage } from '../../orchestrator/router.js';
import { runAgent } from '../../agents/runner.js';
import { getAgent, getDefaultAgent } from '../../agents/registry.js';
import { agentQueue } from '../../orchestrator/queue.js';
import { createStreamResponder } from '../stream-responder.js';
import { findThreadOwner } from '../../memory/sessions.js';

export function registerMessageListener(app: App): void {
  app.message(async ({ message, client }) => {
    // Handle DMs and private channels (group)
    const channelType = (message as unknown as Record<string, unknown>).channel_type as string | undefined;
    if (channelType !== 'im' && channelType !== 'group') return;

    // Skip bot messages to avoid loops
    if ('bot_id' in message) return;
    // Also skip message subtypes (edits, joins, etc.)
    if ('subtype' in message) return;

    const msg = message as unknown as Record<string, unknown>;
    const text = msg.text as string | undefined;
    const userId = msg.user as string | undefined;
    const messageTs = msg.ts as string | undefined;
    const threadTs = msg.thread_ts as string | undefined;

    if (!text || !userId || !messageTs) return;

    // Get bot user ID for mention stripping
    const authResult = await client.auth.test();
    const botUserId = authResult.user_id as string;

    // Route through the normal router (works for both DMs and private channels)
    const route = routeMessage(text, botUserId);
    let agentId = route.agentId;
    const cleanedText = route.cleanedText;

    // Thread continuity: if router defaulted to otto but thread belongs to
    // another agent, continue with that agent.
    if (agentId === 'otto' && threadTs) {
      const threadAgent = await findThreadOwner(msg.channel as string, threadTs);
      if (threadAgent && threadAgent !== 'otto') {
        agentId = threadAgent;
        logger.debug(
          { channel: msg.channel as string, threadTs, threadAgent },
          'Thread continuity: routing to existing thread owner',
        );
      }
    }

    const agent = getAgent(agentId) ?? getDefaultAgent();
    const agentName = agent.config.display_name;

    logger.info(
      { channel: msg.channel as string, user: userId, agentId, channelType, text: cleanedText },
      channelType === 'im' ? 'Received DM' : 'Received channel message',
    );

    // Set up the streaming responder
    const responder = createStreamResponder({
      client,
      channel: msg.channel as string,
      threadTs: threadTs ?? messageTs,
      userMessageTs: messageTs,
      agentName,
    });

    try {
      const result = await agentQueue.enqueue(msg.channel as string, () =>
        runAgent({
          agentId,
          userMessage: cleanedText,
          userId,
          channelId: msg.channel as string,
          threadTs: threadTs ?? messageTs,
          onText: responder.onText,
        }),
      );

      await responder.finalize(result.response, result.usage);
    } catch (err) {
      logger.error({ err, channel: msg.channel as string, user: userId }, 'Agent run failed');
      await responder.onError(err);
    }
  });
}
