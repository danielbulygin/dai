import type { App } from '@slack/bolt';
import { logger } from '../../utils/logger.js';
import { routeMessage } from '../../orchestrator/router.js';
import { runAgent } from '../../agents/runner.js';
import { getAgent, getDefaultAgent } from '../../agents/registry.js';
import { agentQueue } from '../../orchestrator/queue.js';
import { createStreamResponder } from '../stream-responder.js';
import { findThreadOwner } from '../../memory/sessions.js';
import { isInsightThread } from '../../learning/insight-approval.js';
import { transcribeAudioFiles } from '../voice.js';
import { tryDeterministicLaunchApproval } from '../launch-approval.js';

export function registerMessageListener(app: App): void {
  app.message(async ({ message, client }) => {
    // Handle DMs and private channels (group)
    const channelType = (message as unknown as Record<string, unknown>).channel_type as string | undefined;
    if (channelType !== 'im' && channelType !== 'group') return;

    // Skip bot messages to avoid loops
    if ('bot_id' in message) return;
    // Allow file_share subtype (voice notes), skip everything else
    const subtype = (message as unknown as Record<string, unknown>).subtype as string | undefined;
    if (subtype && subtype !== 'file_share') return;

    const msg = message as unknown as Record<string, unknown>;
    let text = msg.text as string | undefined;
    const userId = msg.user as string | undefined;
    const messageTs = msg.ts as string | undefined;
    const threadTs = msg.thread_ts as string | undefined;
    const files = msg.files as Array<Record<string, unknown>> | undefined;

    if (!userId || !messageTs) return;
    // Narrowed aliases — control-flow narrowing doesn't carry into the
    // hoisted handleMessage() declaration below.
    const safeUserId: string = userId;
    const safeMessageTs: string = messageTs;

    // Transcribe voice notes if present
    const transcript = await transcribeAudioFiles(files, client);
    if (transcript) {
      text = text ? `${text}\n\n[Voice note]: ${transcript}` : transcript;
    }

    if (!text) return;
    const messageText = text;

    // Guaranteed closure: anything that throws BEFORE the stream responder
    // exists used to die silently — the user saw nothing at all.
    try {
      await handleMessage();
    } catch (err) {
      logger.error({ err, channel: msg.channel as string, user: userId }, 'Message handler failed before responder setup');
      try {
        await client.chat.postMessage({
          channel: msg.channel as string,
          thread_ts: threadTs ?? messageTs,
          text: ':x: Something went wrong before I could start on that — please try again.',
        });
      } catch {
        // Slack itself unreachable — nothing more we can do.
      }
    }
    return;

    async function handleMessage(): Promise<void> {
    const text = messageText;
    const userId = safeUserId;
    const messageTs = safeMessageTs;

    // Skip insight approval threads — handled by insight-actions.ts
    if (threadTs) {
      const isInsight = await isInsightThread(threadTs);
      if (isInsight) return;
    }

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

    // Deterministic launch-approval routing: a typed approval in a thread with
    // pending launch batches executes launchAds directly (same path as the
    // [Launch] button) — the model never gets a chance to fabricate the result.
    // See slack/launch-approval.ts + the 2026-06-05 incident.
    if (threadTs) {
      const handled = await tryDeterministicLaunchApproval({
        text: cleanedText,
        channelId: msg.channel as string,
        threadTs,
        agentId,
        userId,
        postReply: async (replyText) => {
          await client.chat.postMessage({
            channel: msg.channel as string,
            thread_ts: threadTs,
            text: replyText,
          });
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
      channel: msg.channel as string,
      threadTs: threadTs ?? messageTs,
      userMessageTs: messageTs,
      agentName,
    });

    // If another task is running in this channel, say so — a silent queue
    // wait reads as a hang (the team re-asks or gives up).
    if (agentQueue.isChannelBusy(msg.channel as string)) {
      responder.setStatus('is queued behind another task in this channel — starting as soon as it finishes...');
    }

    try {
      const result = await agentQueue.enqueue(msg.channel as string, () =>
        runAgent({
          agentId,
          userMessage: cleanedText,
          userId,
          channelId: msg.channel as string,
          threadTs: threadTs ?? messageTs,
          onText: responder.onText,
          onTurnReset: responder.resetAccumulated,
        }),
      );

      await responder.finalize(result.response, result.usage);
    } catch (err) {
      logger.error({ err, channel: msg.channel as string, user: userId }, 'Agent run failed');
      await responder.onError(err);
    }
    }
  });
}
