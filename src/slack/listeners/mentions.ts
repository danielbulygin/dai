import type { App } from '@slack/bolt';
import { logger } from '../../utils/logger.js';
import { routeMessage } from '../../orchestrator/router.js';
import { runAgent } from '../../agents/runner.js';
import { getAgent, getDefaultAgent } from '../../agents/registry.js';
import { agentQueue } from '../../orchestrator/queue.js';
import { createStreamResponder } from '../stream-responder.js';
import { findThreadOwner } from '../../memory/sessions.js';

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

    // Thread continuity: if router defaulted to otto but a thread already
    // belongs to another agent, continue with that agent instead.
    let agentId = route.agentId;
    if (agentId === 'otto' && thread_ts) {
      const threadAgent = findThreadOwner(channel, threadTs);
      if (threadAgent && threadAgent !== 'otto') {
        agentId = threadAgent;
        logger.debug(
          { channel, threadTs, threadAgent },
          'Thread continuity: routing to existing thread owner',
        );
      }
    }

    const agent = getAgent(agentId) ?? getDefaultAgent();
    const agentName = agent.config.display_name;

    logger.info(
      { channel, user, agentId, text: route.cleanedText },
      'Received app_mention',
    );

    // Set up the streaming responder
    const responder = createStreamResponder({
      client,
      channel,
      threadTs,
      userMessageTs: ts,
      agentName,
    });

    // Run the agent through the queue
    try {
      const result = await agentQueue.enqueue(channel, () =>
        runAgent({
          agentId,
          userMessage: route.cleanedText,
          userId: user,
          channelId: channel,
          threadTs,
          onText: responder.onText,
        }),
      );

      await responder.finalize(result.response, result.usage);
    } catch (err) {
      logger.error({ err, channel, user }, 'Agent run failed');
      await responder.onError(err);
    }
  });
}
