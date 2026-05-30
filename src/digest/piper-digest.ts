/**
 * Piper morning digest (Phase 3 — Slack proactive observer).
 *
 * Runs the Piper agent with a digest prompt, then posts the result to #piper
 * AS Piper (via his dedicated bot client). The agent only GENERATES the text;
 * posting is done here so we control the channel and the bot identity.
 *
 * Why post here instead of letting the agent call post_message:
 *   slackTools.postMessage uses the MAIN dai bot token, so an agent-driven post
 *   would appear as "DAI", not "Piper". getDedicatedBotClient('piper') gives us
 *   Piper's WebClient (falls back to the main bot only if Piper's tokens are unset).
 *
 * Triggered by the droplet systemd timer → POST /api/cron/piper-digest (Mon-Fri
 * 09:00 ET). Also runnable standalone for testing: `pnpm digest:piper [--post]`.
 */

import { randomUUID } from 'node:crypto';
import { WebClient } from '@slack/web-api';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { runAgent } from '../agents/runner.js';
import { getDedicatedBotClient } from '../slack/dedicated-bots.js';

export interface DigestResult {
  posted: boolean;
  channel: string | null;
  ts?: string;
  digest: string;
  turns: number;
}

/**
 * The instruction handed to Piper to assemble the morning digest. Kept here (not
 * in METHODOLOGY.md) because it's the machine trigger; the human-facing shape of
 * the digest is documented in agents/piper/METHODOLOGY.md under "Morning digest".
 */
function buildDigestPrompt(): string {
  return [
    'Produce your MORNING DIGEST for the whole AOT pipeline. This is the unprompted',
    'Monday-Friday post, not a reply to a person. Follow your METHODOLOGY "Morning digest" shape.',
    '',
    'Assemble it from your tools, in this order:',
    '1. list_clients → the active client set.',
    '2. count_aot_tasks(status_group:"active", group_by:"client") and count_aot_adsets(group_by:"client")',
    '   to get per-client overdue + blocked counts cheaply. Reach for count_* before query_* — the',
    '   digest is numbers, not row dumps. Drop into query_aot_tasks/query_aot_adsets only to name the',
    '   specific top 3-5 overdue/blocked items per client (code, owner, days-overdue, one-clause reason).',
    '3. Separate REAL overdue (Status active + edited within ~7d + parent ad set still live) from ZOMBIES',
    '   (stale >90d / dead-stage / inactive-client). Lead with real overdue; roll zombies into a single',
    '   "+N stale/zombie (cleanup, not action)" line. Never let zombies inflate the headline.',
    '4. inspect_data_quality(trend:true) → if any probe jumped materially week-over-week, add ONE',
    '   "pipeline data-quality drift" line naming the metric and the jump. If nothing drifted, say nothing.',
    '5. get_cadence_read_all → include tracking-pct lines ONLY for clients that have a real stored target.',
    '   The targets table is empty pending Vanessa, so this will likely be empty — that is fine, omit it.',
    '   Do NOT invent or imply targets.',
    '',
    'Format: Slack mrkdwn (single * for bold, • bullets). Status-first headline sentence. Order clients by',
    'severity (most real-overdue first). End with an explicit all-clear line for clients with nothing slipping.',
    'Keep it scannable — top 3-5 items per client, top clients first, the rest as counts. ~500 tokens.',
    '',
    'IMPORTANT: Output ONLY the digest text as your reply. Do NOT call post_message or reply_in_thread —',
    'the system posts your reply to #piper for you.',
  ].join('\n');
}

/**
 * Generate the digest by running Piper, then (unless dryRun) post it to #piper
 * as Piper. Channel resolves from opts.channelId ?? env.PIPER_CHANNEL_ID.
 */
export async function runPiperDigest(
  opts: { channelId?: string; dryRun?: boolean } = {},
): Promise<DigestResult> {
  const channel = opts.channelId ?? env.PIPER_CHANNEL_ID ?? null;
  const dryRun = opts.dryRun ?? false;

  if (!channel && !dryRun) {
    throw new Error(
      'No digest channel: set PIPER_CHANNEL_ID (the #piper channel ID) or pass channelId.',
    );
  }

  const sessionId = `cron-digest-${randomUUID()}`;
  const started = Date.now();

  logger.info({ channel, dryRun }, 'Piper digest: generating');

  const result = await runAgent({
    agentId: 'piper',
    userMessage: buildDigestPrompt(),
    userId: 'cron',
    channelId: channel ?? 'cron-digest',
    threadTs: sessionId,
    sessionId,
  });

  const digest = result.response.trim();
  logger.info(
    { turns: result.turns, chars: digest.length, ms: Date.now() - started },
    'Piper digest: generated',
  );

  if (dryRun || !channel) {
    return { posted: false, channel, digest, turns: result.turns };
  }

  // Post AS Piper. Build the client straight from PIPER_BOT_TOKEN so this works
  // identically whether we're inside the running service or a standalone script
  // (getDedicatedBotClient only resolves Piper once startDedicatedBots() has run,
  // which the standalone runner never does — it would silently post as the main bot).
  let client: WebClient;
  if (env.PIPER_BOT_TOKEN) {
    client = new WebClient(env.PIPER_BOT_TOKEN);
  } else {
    logger.warn('PIPER_BOT_TOKEN unset — digest will post as the main DAI bot, not Piper.');
    client = getDedicatedBotClient('piper');
  }

  const posted = await client.chat.postMessage({
    channel,
    text: digest,
    unfurl_links: false,
    unfurl_media: false,
  });

  logger.info({ channel, ts: posted.ts }, 'Piper digest: posted');

  return {
    posted: true,
    channel,
    ts: posted.ts ?? undefined,
    digest,
    turns: result.turns,
  };
}
