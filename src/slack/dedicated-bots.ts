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
import { getAgent } from '../agents/registry.js';
import { agentQueue } from '../orchestrator/queue.js';
import { createStreamResponder } from './stream-responder.js';
import { registerReactionListener } from './listeners/reactions.js';
import { registerInsightActions } from './listeners/insight-actions.js';
import { slackApp } from './app.js';

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
    },
    {
      agentId: 'ada',
      botToken: env.ADA_BOT_TOKEN,
      appToken: env.ADA_APP_TOKEN,
      extraListeners: [registerReactionListener, registerInsightActions],
    },
  ];
}

// ---------------------------------------------------------------------------
// Running bot instances
// ---------------------------------------------------------------------------

const runningBots = new Map<string, App>();

// ---------------------------------------------------------------------------
// Generic listener registration (DMs + @mentions → runAgent)
// ---------------------------------------------------------------------------

function stripMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();
}

function registerDedicatedBotListeners(app: App, agentId: string): void {
  // DMs — all messages route to the agent
  app.message(async ({ message, client }) => {
    const msg = message as unknown as Record<string, unknown>;

    if (msg.channel_type !== 'im') return;
    if ('bot_id' in message) return;
    if ('subtype' in message) return;

    const text = msg.text as string | undefined;
    const userId = msg.user as string | undefined;
    const messageTs = msg.ts as string | undefined;
    const threadTs = msg.thread_ts as string | undefined;

    if (!text || !userId || !messageTs) return;

    await handleDedicatedBotMessage({
      client,
      agentId,
      text,
      userId,
      channel: msg.channel as string,
      messageTs,
      threadTs,
      source: 'DM',
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

  const agent = getAgent(agentId);
  if (!agent) {
    logger.error({ agentId }, 'Dedicated bot agent not found in registry');
    return;
  }

  logger.info(
    { channel, user: userId, agentId, source, text },
    `${agent.config.display_name} ${source} received`,
  );

  const responder = createStreamResponder({
    client,
    channel,
    threadTs: threadTs ?? messageTs,
    userMessageTs: messageTs,
    agentName: agent.config.display_name,
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
      }),
    );

    await responder.finalize(result.response, result.usage);
  } catch (err) {
    logger.error({ err, channel, user: userId, agentId }, `${agent.config.display_name} ${source} agent run failed`);
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
