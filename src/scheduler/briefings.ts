import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env.js';
import { postMessage } from '../agents/tools/slack-tools.js';
import { getDaiSupabase } from '../integrations/dai-supabase.js';
import { logger } from '../utils/logger.js';
import { registerJob } from './index.js';

const BRIEFING_MODEL = 'claude-sonnet-4-20250514';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

function getTodayString(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Europe/Berlin',
  });
}

async function persistBriefing(
  type: 'morning' | 'eod' | 'on_demand',
  briefingText: string,
  dataSourcesUsed: number,
): Promise<void> {
  try {
    const supabase = getDaiSupabase();
    const { error } = await supabase.from('briefings').insert({
      type,
      briefing_text: briefingText,
      data_sources_used: dataSourcesUsed,
    });
    if (error) {
      logger.error({ error }, 'Failed to persist briefing to Supabase');
      return;
    }
    logger.info({ type, dataSourcesUsed }, 'Persisted briefing to Supabase');
  } catch (err) {
    logger.error({ err }, 'Failed to persist briefing to Supabase');
  }
}

// ---------------------------------------------------------------------------
// Data gathering helpers (each source wrapped in try/catch)
// ---------------------------------------------------------------------------

async function gatherChannelInsights(): Promise<string | null> {
  try {
    const { getChannelInsights } = await import('../agents/tools/monitoring-tools.js');
    const result = await getChannelInsights();
    if (!result.analysis) return null;

    const parts: string[] = ['## Channel Monitoring Insights'];
    if (result.analysis.blockers.length > 0) {
      parts.push('Blockers on Daniel:');
      for (const item of result.analysis.blockers) parts.push(`- ${item}`);
    }
    if (result.analysis.urgent.length > 0) {
      parts.push('Urgent items:');
      for (const item of result.analysis.urgent) parts.push(`- ${item}`);
    }
    if (result.analysis.notable.length > 0) {
      parts.push('Notable updates:');
      for (const item of result.analysis.notable) parts.push(`- ${item}`);
    }
    if (result.analysis.suggestedActions.length > 0) {
      parts.push('Suggested actions:');
      for (const item of result.analysis.suggestedActions) parts.push(`- ${item}`);
    }
    parts.push(`(Based on ${result.analysis.messageCount} messages)`);
    return parts.join('\n');
  } catch (err) {
    logger.debug({ err }, 'Channel insights unavailable for briefing');
    return null;
  }
}

async function gatherRecentMentions(hours: number): Promise<string | null> {
  try {
    const { getRecentMentions } = await import('../agents/tools/monitoring-tools.js');
    const result = await getRecentMentions({ hours });
    if (result.count === 0) return null;

    const parts: string[] = [`## Recent Mentions (last ${hours}h) — ${result.count} total`];
    for (const mention of result.mentions.slice(0, 15)) {
      const text = mention.text.length > 200 ? mention.text.slice(0, 200) + '...' : mention.text;
      parts.push(`- [${mention.priority}] <@${mention.user_id}> in <#${mention.channel_id}>: ${text}`);
    }
    return parts.join('\n');
  } catch (err) {
    logger.debug({ err }, 'Recent mentions unavailable for briefing');
    return null;
  }
}

async function gatherNotionTasks(
  statuses: string[],
  assignee?: string,
): Promise<string | null> {
  try {
    const { queryTasks } = await import('../agents/tools/notion-tools.js');
    const parts: string[] = ['## Notion Tasks'];

    for (const status of statuses) {
      const params: { status: string; assignee?: string } = { status };
      if (assignee) params.assignee = assignee;
      const rawResult = await queryTasks(params);
      const tasks = JSON.parse(rawResult);

      if (Array.isArray(tasks) && tasks.length > 0) {
        parts.push(`### ${status} (${tasks.length})`);
        for (const task of tasks.slice(0, 10)) {
          const priority = task.priority ? ` [${task.priority}]` : '';
          const due = task.dueDate ? ` (due: ${task.dueDate})` : '';
          parts.push(`- ${task.title}${priority}${due}`);
        }
      }
    }

    return parts.length > 1 ? parts.join('\n') : null;
  } catch (err) {
    logger.debug({ err }, 'Notion tasks unavailable for briefing');
    return null;
  }
}

async function gatherRecentMeetings(days: number): Promise<string | null> {
  try {
    const { listRecentMeetings } = await import('../agents/tools/fireflies-tools.js');
    const rawResult = await listRecentMeetings({ days });
    const meetings = JSON.parse(rawResult);

    if (!Array.isArray(meetings) || meetings.length === 0) return null;

    const parts: string[] = [`## Recent Meetings (last ${days} day${days === 1 ? '' : 's'})`];
    for (const meeting of meetings.slice(0, 10)) {
      const date = meeting.date ? new Date(meeting.date).toLocaleDateString() : '';
      const summary = meeting.short_summary ?? '';
      parts.push(`- ${meeting.title} (${date}): ${summary}`);
    }
    return parts.join('\n');
  } catch (err) {
    logger.debug({ err }, 'Recent meetings unavailable for briefing');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Morning briefing
// ---------------------------------------------------------------------------

export async function generateMorningBriefing(): Promise<string> {
  logger.info('Generating morning briefing');

  const dataSections: string[] = [];

  // Gather data from all sources concurrently
  const [insights, mentions, tasks, meetings] = await Promise.all([
    gatherChannelInsights(),
    gatherRecentMentions(14), // Since last EOD ~7pm
    gatherNotionTasks(['In Progress', 'To Do'], 'Daniel'),
    gatherRecentMeetings(1),
  ]);

  if (insights) dataSections.push(insights);
  if (mentions) dataSections.push(mentions);
  if (tasks) dataSections.push(tasks);
  if (meetings) dataSections.push(meetings);

  const dataSummary = dataSections.length > 0
    ? dataSections.join('\n\n')
    : 'No data available from any source at this time.';

  const today = getTodayString();

  const systemPrompt = [
    'You are Jasmin, Daniel\'s personal assistant. Write a concise morning briefing for Daniel.',
    `Today is ${today}. Daniel is based in Berlin (Europe/Berlin).`,
    '',
    'Structure the briefing as:',
    '1. **Top Priority** — The single most important thing to address first',
    '2. **Blockers & Urgent** — Things people are waiting on Daniel for, time-sensitive items',
    '3. **Today\'s Tasks** — What\'s on Daniel\'s plate (from Notion)',
    '4. **Meetings** — Any meetings from yesterday with unresolved action items',
    '5. **Notable** — Important but not urgent updates',
    '',
    'Keep it scannable — use bullet points, bold key names/items. No fluff.',
    'If a data source is unavailable, skip that section silently.',
    'End with a brief motivational note or reminder (keep it natural, not cheesy).',
  ].join('\n');

  try {
    const response = await getClient().messages.create({
      model: BRIEFING_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Here is the data gathered for today's morning briefing:\n\n${dataSummary}`,
        },
      ],
    });

    const briefingText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    logger.info(
      { briefingLength: briefingText.length, dataSources: dataSections.length },
      'Morning briefing generated',
    );

    // Post to Daniel's DM
    await postMessage({
      channel: env.SLACK_OWNER_USER_ID,
      text: `:sunrise: *Morning Briefing*\n\n${briefingText}`,
    });

    logger.info('Morning briefing sent to Daniel');

    // Persist to Supabase (best-effort)
    await persistBriefing('morning', briefingText, dataSections.length);

    return briefingText;
  } catch (err) {
    logger.error({ err }, 'Failed to generate morning briefing');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// End-of-day briefing
// ---------------------------------------------------------------------------

export async function generateEodBriefing(): Promise<string> {
  logger.info('Generating end-of-day briefing');

  const dataSections: string[] = [];

  // Gather data from all sources concurrently
  const [insights, mentions, tasks, meetings] = await Promise.all([
    gatherChannelInsights(),
    gatherRecentMentions(10), // Today's mentions
    gatherNotionTasks(['Done', 'In Progress']),
    gatherRecentMeetings(1),
  ]);

  if (insights) dataSections.push(insights);
  if (mentions) dataSections.push(mentions);
  if (tasks) dataSections.push(tasks);
  if (meetings) dataSections.push(meetings);

  const dataSummary = dataSections.length > 0
    ? dataSections.join('\n\n')
    : 'No data available from any source at this time.';

  const today = getTodayString();

  const systemPrompt = [
    'You are Jasmin, Daniel\'s personal assistant. Write a concise end-of-day summary.',
    `Today is ${today}.`,
    '',
    'Structure:',
    '1. **Completed Today** — What got done',
    '2. **Still Open** — What\'s still in progress or unresolved',
    '3. **Unresolved Blockers** — Anything people are still waiting on Daniel for',
    '4. **Tomorrow Preview** — Quick look at what\'s coming',
    '',
    'Keep it brief and scannable. Focus on closure — what can Daniel stop thinking about,',
    'and what should he pick up tomorrow.',
  ].join('\n');

  try {
    const response = await getClient().messages.create({
      model: BRIEFING_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Here is the data gathered for today's end-of-day summary:\n\n${dataSummary}`,
        },
      ],
    });

    const briefingText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    logger.info(
      { briefingLength: briefingText.length, dataSources: dataSections.length },
      'EOD briefing generated',
    );

    // Post to Daniel's DM
    await postMessage({
      channel: env.SLACK_OWNER_USER_ID,
      text: `:moon: *End-of-Day Summary*\n\n${briefingText}`,
    });

    logger.info('EOD briefing sent to Daniel');

    // Persist to Supabase (best-effort)
    await persistBriefing('eod', briefingText, dataSections.length);

    return briefingText;
  } catch (err) {
    logger.error({ err }, 'Failed to generate EOD briefing');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerBriefingJobs(): void {
  registerJob(
    'morning-briefing',
    '0 9 * * 1-5', // 9am weekdays
    'Europe/Berlin',
    async () => { await generateMorningBriefing(); },
  );

  registerJob(
    'eod-briefing',
    '0 19 * * 1-5', // 7pm weekdays
    'Europe/Berlin',
    async () => { await generateEodBriefing(); },
  );
}
