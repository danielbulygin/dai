/**
 * Configuration-driven dedicated bot system.
 *
 * Each agent can have its own Slack bot identity. Adding a new one:
 * 1. Create a Slack app (use ada-manifest.json as template)
 * 2. Add 2 env vars: {AGENT}_BOT_TOKEN, {AGENT}_APP_TOKEN
 * 3. Add one entry to getDedicatedBotConfigs() below
 */

import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { runAgent } from '../agents/runner.js';
import type { RunOptions } from '../agents/runner.js';
import { getAgent } from '../agents/registry.js';
import { getClientAgentByChannel } from '../client-agents/config.js';
import { findThreadOwner } from '../memory/sessions.js';
import { agentQueue } from '../orchestrator/queue.js';
import { createStreamResponder } from './stream-responder.js';
import { registerReactionListener } from './listeners/reactions.js';
import { registerInsightActions } from './listeners/insight-actions.js';
import { registerEmailActions } from './listeners/email-actions.js';
import { registerTriageActions } from './listeners/triage-actions.js';
import { slackApp } from './app.js';
import { transcribeAudioFiles } from './voice.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface DedicatedBotConfig {
  agentId: string;
  botToken: string | undefined;
  appToken: string | undefined;
  /** Extra listeners to register beyond DMs + @mentions */
  extraListeners?: Array<(app: App) => void>;
}

function getDedicatedBotConfigs(): DedicatedBotConfig[] {
  return [
    {
      agentId: 'jasmin',
      botToken: env.JASMIN_BOT_TOKEN,
      appToken: env.JASMIN_APP_TOKEN,
      extraListeners: [registerEmailActions, registerTriageActions],
    },
    {
      agentId: 'ada',
      botToken: env.ADA_BOT_TOKEN,
      appToken: env.ADA_APP_TOKEN,
      extraListeners: [registerReactionListener, registerInsightActions],
    },
    {
      agentId: 'maya',
      botToken: env.MAYA_BOT_TOKEN,
      appToken: env.MAYA_APP_TOKEN,
    },
  ];
}

// ---------------------------------------------------------------------------
// Running bot instances + thread tracking
// ---------------------------------------------------------------------------

const runningBots = new Map<string, App>();

/** Tracks threads each dedicated bot has participated in (agentId → Set<threadTs>) */
const activeThreads = new Map<string, Set<string>>();

function trackThread(agentId: string, threadTs: string): void {
  if (!activeThreads.has(agentId)) activeThreads.set(agentId, new Set());
  activeThreads.get(agentId)!.add(threadTs);
}

// ---------------------------------------------------------------------------
// Generic listener registration (DMs + @mentions + thread replies → runAgent)
// ---------------------------------------------------------------------------

function stripMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();
}

/** Parse comma-separated user IDs from ADA_DM_ALLOWED_USERS env var */
function getAdaDmAllowedUsers(): Set<string> | null {
  const raw = env.ADA_DM_ALLOWED_USERS;
  if (!raw) return null; // not configured = no restriction
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

function registerDedicatedBotListeners(app: App, agentId: string): void {
  // DMs — all messages route to the agent
  app.message(async ({ message, client }) => {
    const msg = message as unknown as Record<string, unknown>;

    if (msg.channel_type !== 'im') return;
    if ('bot_id' in message) return;
    // Allow file_share subtype (voice notes), skip everything else
    const subtype = msg.subtype as string | undefined;
    if (subtype && subtype !== 'file_share') return;

    let text = msg.text as string | undefined;
    const userId = msg.user as string | undefined;
    const messageTs = msg.ts as string | undefined;
    const threadTs = msg.thread_ts as string | undefined;
    const files = msg.files as Array<Record<string, unknown>> | undefined;

    if (!userId || !messageTs) return;

    // Ada DM access control — only allowed users can DM Ada directly
    if (agentId === 'ada') {
      const allowed = getAdaDmAllowedUsers();
      if (allowed && !allowed.has(userId)) {
        logger.warn({ userId, agentId }, 'Unauthorized Ada DM attempt — blocked');
        await client.chat.postMessage({
          channel: msg.channel as string,
          text: 'Sorry, I can only chat in our shared channel. Please reach out to me there!',
        });
        return;
      }
    }

    // Transcribe voice notes if present
    const transcript = await transcribeAudioFiles(files, client);
    if (transcript) {
      text = text ? `${text}\n\n[Voice note]: ${transcript}` : transcript;
    }

    if (!text) return;

    await handleDedicatedBotMessage({
      client,
      agentId,
      text,
      userId,
      channel: msg.channel as string,
      messageTs,
      threadTs,
      source: transcript ? 'voice DM' : 'DM',
    });
  });

  // Channel @mentions
  app.event('app_mention', async ({ event, client }) => {
    const { text, channel, thread_ts, ts } = event;
    const user = event.user ?? 'unknown';

    const authResult = await client.auth.test();
    const botUserId = authResult.user_id as string;
    const cleanedText = stripMention(text, botUserId);

    await handleDedicatedBotMessage({
      client,
      agentId,
      text: cleanedText,
      userId: user,
      channel,
      messageTs: ts,
      threadTs: thread_ts,
      source: 'mention',
    });
  });

  // Channel thread replies — continue conversation without requiring @mention
  app.message(async ({ message, client }) => {
    const msg = message as unknown as Record<string, unknown>;

    // Only channel thread replies (DMs handled above)
    if (msg.channel_type === 'im') return;
    if (!msg.thread_ts) return;
    if ('bot_id' in message) return;
    if ('subtype' in message) return;

    const threadTs = msg.thread_ts as string;
    const threads = activeThreads.get(agentId);
    if (!threads?.has(threadTs)) {
      // Fallback: check Supabase sessions (survives restarts)
      const owner = await findThreadOwner(msg.channel as string, threadTs);
      if (!owner || !owner.startsWith(agentId)) return;
      // Re-track the thread so future replies skip the DB lookup
      trackThread(agentId, threadTs);
    }

    const text = msg.text as string | undefined;
    const userId = msg.user as string | undefined;
    const messageTs = msg.ts as string | undefined;

    if (!text || !userId || !messageTs) return;

    await handleDedicatedBotMessage({
      client,
      agentId,
      text,
      userId,
      channel: msg.channel as string,
      messageTs,
      threadTs,
      source: 'thread',
    });
  });
}

async function handleDedicatedBotMessage(opts: {
  client: WebClient;
  agentId: string;
  text: string;
  userId: string;
  channel: string;
  messageTs: string;
  threadTs: string | undefined;
  source: string;
}): Promise<void> {
  const { client, agentId, text, userId, channel, messageTs, threadTs, source } = opts;

  // Check if this is a client-scoped channel (only for Ada bot)
  let clientScope: RunOptions['clientScope'] | undefined;
  if (agentId === 'ada') {
    const clientConfig = await getClientAgentByChannel(channel);
    if (clientConfig) {
      clientScope = {
        clientCode: clientConfig.clientCode,
        displayName: clientConfig.displayName,
      };
    }
  }

  const agent = getAgent(agentId);
  if (!agent) {
    logger.error({ agentId }, 'Dedicated bot agent not found in registry');
    return;
  }

  const displayName = clientScope
    ? `Ada (${clientScope.displayName})`
    : agent.config.display_name;

  logger.info(
    { channel, user: userId, agentId, source, text, clientScope: clientScope?.clientCode },
    `${displayName} ${source} received`,
  );

  const responder = createStreamResponder({
    client,
    channel,
    threadTs: threadTs ?? messageTs,
    userMessageTs: messageTs,
    agentName: displayName,
  });

  try {
    const result = await agentQueue.enqueue(channel, () =>
      runAgent({
        agentId,
        userMessage: text,
        userId,
        channelId: channel,
        threadTs: threadTs ?? messageTs,
        onText: responder.onText,
        clientScope,
      }),
    );

    await responder.finalize(result.response, result.usage);
    trackThread(agentId, threadTs ?? messageTs);
  } catch (err) {
    logger.error({ err, channel, user: userId, agentId }, `${displayName} ${source} agent run failed`);
    await responder.onError(err);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function startDedicatedBots(): Promise<void> {
  for (const config of getDedicatedBotConfigs()) {
    if (!config.botToken || !config.appToken) continue;

    const app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });

    registerDedicatedBotListeners(app, config.agentId);

    if (config.extraListeners) {
      for (const register of config.extraListeners) {
        register(app);
      }
    }

    await app.start();
    runningBots.set(config.agentId, app);
    logger.info({ agentId: config.agentId }, `Dedicated bot ${config.agentId} started`);
  }
}

export async function stopDedicatedBots(): Promise<void> {
  const stops = Array.from(runningBots.entries()).map(([agentId, app]) =>
    app.stop().then(() => logger.info({ agentId }, `Dedicated bot ${agentId} stopped`)),
  );
  await Promise.all(stops);
  runningBots.clear();
}

// ---------------------------------------------------------------------------
// Client accessor — used by insight-approval, briefings, etc.
// ---------------------------------------------------------------------------

/**
 * Get the WebClient for a dedicated bot. Falls back to the main DAI bot
 * if the agent doesn't have a dedicated bot configured.
 */
export function getDedicatedBotClient(agentId: string): WebClient {
  const app = runningBots.get(agentId);
  if (app) return app.client;
  return slackApp.client;
}
