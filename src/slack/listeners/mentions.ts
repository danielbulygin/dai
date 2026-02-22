import type { App } from '@slack/bolt';
import { logger } from '../../utils/logger.js';
import { routeMessage } from '../../orchestrator/router.js';
import { runAgent } from '../../agents/runner.js';
import { getAgent, getDefaultAgent } from '../../agents/registry.js';
import { agentQueue } from '../../orchestrator/queue.js';
import { createStreamResponder } from '../stream-responder.js';

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

    const agent = getAgent(route.agentId) ?? getDefaultAgent();
    const agentName = agent.config.display_name;

    logger.info(
      { channel, user, agentId: route.agentId, text: route.cleanedText },
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
          agentId: route.agentId,
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
