import type { App } from '@slack/bolt';
import { logger } from '../../utils/logger.js';
import { routeMessage } from '../../orchestrator/router.js';
import { runAgent } from '../../agents/runner.js';
import { getAgent, getDefaultAgent } from '../../agents/registry.js';
import { agentQueue } from '../../orchestrator/queue.js';
import { createStreamResponder } from '../stream-responder.js';
import { findThreadOwner } from '../../memory/sessions.js';
import { tryDeterministicLaunchApproval } from '../launch-approval.js';

export function registerMentionListener(app: App): void {
  app.event('app_mention', async ({ event, client }) => {
    const { text, channel, thread_ts, ts } = event;
    const user = event.user ?? 'unknown';
    const threadTs = thread_ts ?? ts;

    // Bot-authored mentions must not trigger agents — agents tagging each
    // other mention-loop otherwise (Ada↔Piper, 2026-06-03). Deliberate
    // agent-to-agent calls go through ask_agent.
    const ev = event as unknown as Record<string, unknown>;
    if (ev.bot_id || ev.bot_profile || ev.subtype === 'bot_message') return;

    // Guaranteed closure: anything that throws BEFORE the stream responder
    // exists (auth.test, routing, launch-approval lookup) used to die silently
    // — the user saw nothing at all. Always post SOMETHING.
    try {
      await handleMention();
    } catch (err) {
      logger.error({ err, channel, user }, 'Mention handler failed before responder setup');
      try {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: ':x: Something went wrong before I could start on that — please try again.',
        });
      } catch {
        // Slack itself unreachable — nothing more we can do.
      }
    }

    async function handleMention(): Promise<void> {
    // Get bot user ID for stripping @mention
    const authResult = await client.auth.test();
    const botUserId = authResult.user_id as string;

    // Route to the correct agent
    const route = routeMessage(text, botUserId);

    // Thread continuity: if router defaulted to otto but a thread already
    // belongs to another agent, continue with that agent instead.
    let agentId = route.agentId;
    if (agentId === 'otto' && thread_ts) {
      const threadAgent = await findThreadOwner(channel, threadTs);
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

    // Deterministic launch-approval routing — see slack/launch-approval.ts and
    // the matching block in messages.ts (2026-06-05 incident hardening).
    if (thread_ts) {
      const handled = await tryDeterministicLaunchApproval({
        text: route.cleanedText,
        channelId: channel,
        threadTs,
        agentId,
        userId: user,
        postReply: async (replyText) => {
          await client.chat.postMessage({ channel, thread_ts: threadTs, text: replyText });
        },
      }).catch((err) => {
        logger.error({ err }, 'Deterministic launch approval failed — falling back to agent');
        return false;
      });
      if (handled) return;
    }

    // Set up the streaming responder
    const responder = createStreamResponder({
      client,
      channel,
      threadTs,
      userMessageTs: ts,
      agentName,
    });

    // If another task is running in this channel, say so — a silent queue
    // wait reads as a hang (the team re-asks or gives up).
    if (agentQueue.isChannelBusy(channel)) {
      responder.setStatus('is queued behind another task in this channel — starting as soon as it finishes...');
    }

    // Run the agent through the queue
    try {
      const result = await agentQueue.enqueue(channel, () =>
        runAgent({
          source: 'interactive',
          agentId,
          userMessage: route.cleanedText,
          userId: user,
          channelId: channel,
          threadTs,
          onText: responder.onText,
          onTurnReset: responder.resetAccumulated,
        }),
      );

      await responder.finalize(result.response, result.usage);
    } catch (err) {
      logger.error({ err, channel, user }, 'Agent run failed');
      await responder.onError(err);
    }
    }
  });
}
