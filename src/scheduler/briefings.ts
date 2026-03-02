import Anthropic from '@anthropic-ai/sdk';
import { WebClient } from '@slack/web-api';
import { env } from '../env.js';
import { postMessage, getUnreadDMs } from '../agents/tools/slack-tools.js';
import { getDaiSupabase } from '../integrations/dai-supabase.js';
import { getDedicatedBotClient } from '../slack/dedicated-bots.js';
import { logger } from '../utils/logger.js';
import { registerJob } from './index.js';

const BRIEFING_MODEL = 'claude-sonnet-4-20250514';

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function berlinDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
}

function formatEventTime(start: string, end: string): string {
  if (!start.includes('T')) return 'All day';
  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/Berlin',
  };
  const s = new Date(start).toLocaleTimeString('en-GB', timeOpts);
  const e = new Date(end).toLocaleTimeString('en-GB', timeOpts);
  return `${s}–${e}`;
}

function formatTimeAgo(tsSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000 - tsSeconds);
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// User name cache (persists within process lifetime)
const userNameCache = new Map<string, string>();

async function resolveUserName(slackClient: WebClient, userId: string): Promise<string> {
  if (userNameCache.has(userId)) return userNameCache.get(userId)!;
  try {
    const info = await slackClient.users.info({ user: userId });
    const name = info.user?.real_name ?? info.user?.name ?? userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    userNameCache.set(userId, userId);
    return userId;
  }
}

// DM channels cache (refreshes every hour)
let dmChannelsCache: { ids: string[]; fetchedAt: number } | null = null;
const DM_CACHE_TTL = 3_600_000;

async function getDmChannelIds(userClient: WebClient): Promise<string[]> {
  if (dmChannelsCache && Date.now() - dmChannelsCache.fetchedAt < DM_CACHE_TTL) {
    return dmChannelsCache.ids;
  }
  const result = await userClient.conversations.list({
    types: 'im',
    limit: 100,
    exclude_archived: true,
  });
  const ids = (result.channels ?? [])
    .map((c) => c.id)
    .filter((id): id is string => Boolean(id));
  dmChannelsCache = { ids, fetchedAt: Date.now() };
  return ids;
}

/** Post briefing via Jasmin's dedicated bot (falls back to DAI bot automatically). */
async function postBriefing(text: string): Promise<void> {
  try {
    await getDedicatedBotClient('jasmin').chat.postMessage({
      channel: env.SLACK_OWNER_USER_ID,
      text,
    });
  } catch (err) {
    logger.debug({ err }, 'Failed to post briefing via dedicated bot, falling back to DAI bot');
    await postMessage({ channel: env.SLACK_OWNER_USER_ID, text });
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persistBriefing(
  type: 'morning' | 'eod' | 'weekly' | 'on_demand',
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

    const parts: string[] = ['*Channel Monitoring Insights*'];
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

    const parts: string[] = [`*Recent Mentions (last ${hours}h)* — ${result.count} total`];
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
    const parts: string[] = ['*Notion Tasks*'];

    for (const status of statuses) {
      const params: { status: string; assignee?: string } = { status };
      if (assignee) params.assignee = assignee;
      const rawResult = await queryTasks(params);
      const tasks = JSON.parse(rawResult);

      if (Array.isArray(tasks) && tasks.length > 0) {
        parts.push(`_${status}_ (${tasks.length})`);
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

    const parts: string[] = [`*Recent Meetings (last ${days} day${days === 1 ? '' : 's'})*`];
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
// New data gathering: Calendar, Emails, DMs, Channel Messages
// ---------------------------------------------------------------------------

async function gatherCalendarEvents(
  type: 'today' | 'tomorrow' | 'week',
): Promise<string | null> {
  try {
    const { listEvents } = await import('../agents/tools/google-tools.js');

    const now = new Date();
    let startDate: string;
    let endDate: string;

    if (type === 'today') {
      startDate = berlinDate(now);
      endDate = berlinDate(new Date(now.getTime() + 86_400_000));
    } else if (type === 'tomorrow') {
      startDate = berlinDate(new Date(now.getTime() + 86_400_000));
      endDate = berlinDate(new Date(now.getTime() + 2 * 86_400_000));
    } else {
      startDate = berlinDate(now);
      endDate = berlinDate(new Date(now.getTime() + 7 * 86_400_000));
    }

    // Query both work and personal calendars in parallel
    const results = await Promise.allSettled(
      (['work', 'personal'] as const).map((account) =>
        listEvents({ startDate, endDate, account }),
      ),
    );

    interface CalEvent {
      summary: string;
      start: string;
      end: string;
      location?: string;
      attendees?: Array<{ email: string; status: string }>;
      account: string;
    }

    const events: CalEvent[] = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const data = JSON.parse(r.value);
      if (data.error || !data.events) continue;
      for (const e of data.events) {
        events.push({
          summary: e.summary ?? '(no title)',
          start: e.start ?? '',
          end: e.end ?? '',
          location: e.location,
          attendees: e.attendees,
          account: data.account,
        });
      }
    }

    if (events.length === 0) return null;

    // Sort by start time
    events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

    // Detect conflicts (overlapping events)
    const conflicts: string[] = [];
    for (let i = 0; i < events.length - 1; i++) {
      if (!events[i].start.includes('T') || !events[i + 1].start.includes('T')) continue;
      const endI = new Date(events[i].end).getTime();
      const startNext = new Date(events[i + 1].start).getTime();
      if (endI > startNext) {
        conflicts.push(`"${events[i].summary}" overlaps with "${events[i + 1].summary}"`);
      }
    }

    const label = type === 'today' ? "Today's" : type === 'tomorrow' ? "Tomorrow's" : "This Week's";
    const parts: string[] = [`*${label} Calendar* (${events.length} events)`];

    for (const e of events) {
      const time = formatEventTime(e.start, e.end);
      const attendeeCount = e.attendees?.length ? ` (${e.attendees.length} attendees)` : '';
      const loc = e.location ? ` — ${e.location}` : '';
      const acct = e.account === 'personal' ? ' [personal]' : '';
      parts.push(`- ${time}: ${e.summary}${attendeeCount}${loc}${acct}`);
    }

    if (conflicts.length > 0) {
      parts.push('Conflicts:');
      for (const c of conflicts) parts.push(`- ${c}`);
    }

    return parts.join('\n');
  } catch (err) {
    logger.debug({ err }, 'Calendar events unavailable for briefing');
    return null;
  }
}

async function gatherImportantEmails(hours: number): Promise<string | null> {
  try {
    const { searchEmails } = await import('../agents/tools/google-tools.js');

    const days = Math.max(1, Math.ceil(hours / 24));
    const query = `is:unread newer_than:${days}d`;

    // Query both work and personal accounts in parallel
    const results = await Promise.allSettled(
      (['work', 'personal'] as const).map((account) =>
        searchEmails({ query, maxResults: 10, account }),
      ),
    );

    interface EmailSummary {
      subject: string;
      from: string;
      date: string;
      snippet: string;
      account: string;
    }

    const emails: EmailSummary[] = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const data = JSON.parse(r.value);
      if (data.error || !data.emails) continue;
      for (const e of data.emails) {
        emails.push({
          subject: e.subject ?? '(no subject)',
          from: e.from ?? 'Unknown',
          date: e.date ?? '',
          snippet: e.snippet ?? '',
          account: data.account,
        });
      }
    }

    if (emails.length === 0) return null;

    // Cap at 15
    const capped = emails.slice(0, 15);

    const parts: string[] = [`*Unread Emails* (${capped.length})`];
    for (const e of capped) {
      const acct = e.account === 'personal' ? ' [personal]' : '';
      const snippet = e.snippet.length > 100 ? e.snippet.slice(0, 100) + '...' : e.snippet;
      parts.push(`- *${e.from}*: ${e.subject}${acct}\n  ${snippet}`);
    }

    return parts.join('\n');
  } catch (err) {
    logger.debug({ err }, 'Emails unavailable for briefing');
    return null;
  }
}

async function gatherSlackDMs(hours: number): Promise<string | null> {
  try {
    const token = env.SLACK_USER_TOKEN;
    if (!token) return null;

    const userClient = new WebClient(token);
    const oldest = String(Math.floor((Date.now() - hours * 3_600_000) / 1000));

    // Get DM channels (cached)
    const dmChannelIds = await getDmChannelIds(userClient);
    if (dmChannelIds.length === 0) return null;

    interface DmMessage {
      user: string;
      text: string;
      ts: string;
    }

    // Read history from each DM channel in parallel
    const channelResults = await Promise.allSettled(
      dmChannelIds.map(async (channelId) => {
        const history = await userClient.conversations.history({
          channel: channelId,
          oldest,
          limit: 10,
        });
        return (history.messages ?? [])
          .filter((msg) =>
            msg.user &&
            msg.user !== env.SLACK_OWNER_USER_ID &&
            !msg.bot_id &&
            !msg.subtype,
          )
          .map((msg): DmMessage => ({
            user: msg.user!,
            text: msg.text ?? '',
            ts: msg.ts ?? '0',
          }));
      }),
    );

    const allMessages: DmMessage[] = channelResults
      .flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

    if (allMessages.length === 0) return null;

    // Sort by timestamp descending and cap at 20
    allMessages.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
    const capped = allMessages.slice(0, 20);

    // Resolve user names
    for (const msg of capped) {
      await resolveUserName(userClient, msg.user);
    }

    const parts: string[] = [`*Slack DMs* (${capped.length} messages)`];
    for (const msg of capped) {
      const name = userNameCache.get(msg.user) ?? msg.user;
      const text = msg.text.length > 200 ? msg.text.slice(0, 200) + '...' : msg.text;
      const timeAgo = formatTimeAgo(parseFloat(msg.ts));
      parts.push(`- *${name}*: ${text} (${timeAgo})`);
    }

    return parts.join('\n');
  } catch (err) {
    logger.debug({ err }, 'Slack DMs unavailable for briefing');
    return null;
  }
}

async function gatherUnreadDMs(): Promise<string | null> {
  try {
    const result = await getUnreadDMs({ limit: 20 });
    if (!result.ok || !result.conversations || result.conversations.length === 0) return null;

    const parts: string[] = [
      `*Unread DMs* (${result.total_unread} messages across ${result.conversations.length} conversations)`,
    ];

    for (const conv of result.conversations) {
      const who = conv.participants.join(', ');
      const label = conv.type === 'group_dm' ? ' [group]' : '';
      parts.push(`\n_${who}${label}_ — ${conv.unread_count} unread:`);
      for (const msg of conv.messages.slice(0, 5)) {
        const text = msg.text.length > 200 ? msg.text.slice(0, 200) + '...' : msg.text;
        parts.push(`  • *${msg.user}*: ${text}`);
      }
    }

    return parts.join('\n');
  } catch (err) {
    logger.debug({ err }, 'Unread DMs unavailable for briefing');
    return null;
  }
}

async function gatherSlackChannelMessages(hours: number): Promise<string | null> {
  try {
    // Get monitored channels from Supabase
    const supabase = getDaiSupabase();
    const { data: monitors } = await supabase
      .from('channel_monitor')
      .select('channel_id')
      .eq('active', true);

    if (!monitors || monitors.length === 0) return null;

    const channelIds = monitors.map((m) => m.channel_id as string);
    const oldest = String(Math.floor((Date.now() - hours * 3_600_000) / 1000));

    const slackClient = new WebClient(env.SLACK_BOT_TOKEN);

    interface ChannelMessage {
      channel: string;
      user: string;
      text: string;
      ts: string;
    }

    // Read history from each channel in parallel
    const channelResults = await Promise.allSettled(
      channelIds.map(async (channelId) => {
        const history = await slackClient.conversations.history({
          channel: channelId,
          oldest,
          limit: 15,
        });
        return (history.messages ?? [])
          .filter((msg) => !msg.bot_id && !msg.subtype)
          .map((msg): ChannelMessage => ({
            channel: channelId,
            user: msg.user ?? 'unknown',
            text: msg.text ?? '',
            ts: msg.ts ?? '0',
          }));
      }),
    );

    const allMessages: ChannelMessage[] = channelResults
      .flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

    if (allMessages.length === 0) return null;

    // Sort by timestamp descending and cap at 30
    allMessages.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
    const capped = allMessages.slice(0, 30);

    // Resolve user names
    for (const msg of capped) {
      await resolveUserName(slackClient, msg.user);
    }

    const parts: string[] = [`*Channel Activity* (${capped.length} messages)`];
    for (const msg of capped) {
      const name = userNameCache.get(msg.user) ?? msg.user;
      const text = msg.text.length > 150 ? msg.text.slice(0, 150) + '...' : msg.text;
      parts.push(`- <#${msg.channel}> — *${name}*: ${text}`);
    }

    return parts.join('\n');
  } catch (err) {
    logger.debug({ err }, 'Channel messages unavailable for briefing');
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
  const [
    insights, mentions, tasks, meetings,
    calendar, emails, dms, unreadDms, channelMessages,
  ] = await Promise.all([
    gatherChannelInsights(),
    gatherRecentMentions(14),
    gatherNotionTasks(['In Progress', 'To Do'], 'Daniel'),
    gatherRecentMeetings(1),
    gatherCalendarEvents('today'),
    gatherImportantEmails(14),
    gatherSlackDMs(14),
    gatherUnreadDMs(),
    gatherSlackChannelMessages(14),
  ]);

  if (calendar) dataSections.push(calendar);
  if (unreadDms) dataSections.push(unreadDms);
  if (emails) dataSections.push(emails);
  if (dms) dataSections.push(dms);
  if (insights) dataSections.push(insights);
  if (mentions) dataSections.push(mentions);
  if (tasks) dataSections.push(tasks);
  if (meetings) dataSections.push(meetings);
  if (channelMessages) dataSections.push(channelMessages);

  const dataSummary = dataSections.length > 0
    ? dataSections.join('\n\n')
    : 'No data available from any source at this time.';

  const today = getTodayString();

  const systemPrompt = [
    'You are Jasmin, Daniel\'s personal assistant and chief of staff. Write a concise morning briefing.',
    `Today is ${today}. Daniel is based in Berlin (Europe/Berlin), works 9am–7pm.`,
    '',
    'FORMATTING: This message will be posted in Slack. Use Slack mrkdwn:',
    '- *bold* for emphasis (single asterisk, NOT double)',
    '- _italic_ for secondary emphasis',
    '- Use bullet points (•) for lists',
    '- NO markdown headers (# or ##) — use *Bold Section Title* instead',
    '- Keep line breaks clean, no excessive whitespace',
    '',
    'Structure the briefing as:',
    '1. *Today\'s Schedule* — Calendar events, flag any conflicts or back-to-back meetings, note gaps',
    '2. *Action Required* — Unreplied DMs, emails needing response, blockers from channels. Prioritize by urgency.',
    '3. *Tasks* — Notion in-progress and to-do items, highlight overdue items',
    '4. *Overnight Activity* — Key Slack messages, channel highlights, meeting follow-ups since last EOD',
    '5. *Notable* — FYI items that don\'t need action but Daniel should be aware of',
    '',
    'IMPORTANT: Prioritize actionable items and group by urgency, not by source.',
    'Tell Daniel what needs his attention, not just dump data.',
    'Keep it scannable. No fluff.',
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

    await postBriefing(`:sunrise: *Morning Briefing*\n\n${briefingText}`);
    logger.info('Morning briefing sent to Daniel');

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
  const [
    insights, mentions, tasks, meetings,
    calendar, emails, dms, unreadDms,
  ] = await Promise.all([
    gatherChannelInsights(),
    gatherRecentMentions(10),
    gatherNotionTasks(['Done', 'In Progress', 'Blocked']),
    gatherRecentMeetings(1),
    gatherCalendarEvents('tomorrow'),
    gatherImportantEmails(10),
    gatherSlackDMs(10),
    gatherUnreadDMs(),
  ]);

  if (tasks) dataSections.push(tasks);
  if (unreadDms) dataSections.push(unreadDms);
  if (dms) dataSections.push(dms);
  if (emails) dataSections.push(emails);
  if (insights) dataSections.push(insights);
  if (mentions) dataSections.push(mentions);
  if (meetings) dataSections.push(meetings);
  if (calendar) dataSections.push(calendar);

  const dataSummary = dataSections.length > 0
    ? dataSections.join('\n\n')
    : 'No data available from any source at this time.';

  const today = getTodayString();

  const systemPrompt = [
    'You are Jasmin, Daniel\'s personal assistant and chief of staff. Write a concise end-of-day summary.',
    `Today is ${today}. Daniel is based in Berlin.`,
    '',
    'FORMATTING: This message will be posted in Slack. Use Slack mrkdwn:',
    '- *bold* for emphasis (single asterisk, NOT double)',
    '- _italic_ for secondary emphasis',
    '- Use bullet points (•) for lists',
    '- NO markdown headers (# or ##) — use *Bold Section Title* instead',
    '',
    'Structure:',
    '1. *Completed Today* — What got done (from Notion "Done" tasks)',
    '2. *Still Needs Your Reply* — Unreplied DMs and emails from today',
    '3. *Open Items* — Unresolved blockers, in-progress tasks, anything people are still waiting on',
    '4. *Tomorrow Preview* — Tomorrow\'s calendar + what\'s coming up',
    '5. *Wind Down* — Brief note on what can wait till tomorrow (or Monday if it\'s Friday)',
    '',
    'Focus on closure — what can Daniel stop thinking about, and what should he pick up tomorrow.',
    'Keep it brief and scannable. Prioritize actionable items.',
    'If a data source is unavailable, skip that section silently.',
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

    await postBriefing(`:moon: *End-of-Day Summary*\n\n${briefingText}`);
    logger.info('EOD briefing sent to Daniel');

    await persistBriefing('eod', briefingText, dataSections.length);
    return briefingText;
  } catch (err) {
    logger.error({ err }, 'Failed to generate EOD briefing');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Weekly briefing (Monday mornings)
// ---------------------------------------------------------------------------

export async function generateWeeklyBriefing(): Promise<string> {
  logger.info('Generating weekly briefing');

  const dataSections: string[] = [];

  // Gather data from all sources concurrently
  const [
    calendar, tasks, emails, dms, unreadDms, channelMessages, meetings,
  ] = await Promise.all([
    gatherCalendarEvents('week'),
    gatherNotionTasks(['To Do', 'In Progress', 'Blocked']),
    gatherImportantEmails(72),
    gatherSlackDMs(72),
    gatherUnreadDMs(),
    gatherSlackChannelMessages(72),
    gatherRecentMeetings(3),
  ]);

  if (calendar) dataSections.push(calendar);
  if (unreadDms) dataSections.push(unreadDms);
  if (dms) dataSections.push(dms);
  if (emails) dataSections.push(emails);
  if (channelMessages) dataSections.push(channelMessages);
  if (tasks) dataSections.push(tasks);
  if (meetings) dataSections.push(meetings);

  const dataSummary = dataSections.length > 0
    ? dataSections.join('\n\n')
    : 'No data available from any source at this time.';

  const today = getTodayString();

  const systemPrompt = [
    'You are Jasmin, Daniel\'s personal assistant and chief of staff. Write a Monday morning weekly overview.',
    `Today is ${today}. Daniel is based in Berlin (Europe/Berlin), works 9am–7pm weekdays.`,
    '',
    'FORMATTING: This message will be posted in Slack. Use Slack mrkdwn:',
    '- *bold* for emphasis (single asterisk, NOT double)',
    '- _italic_ for secondary emphasis',
    '- Use bullet points (•) for lists',
    '- NO markdown headers (# or ##) — use *Bold Section Title* instead',
    '',
    'Structure:',
    '1. *This Week\'s Calendar* — Day-by-day overview of the week ahead, highlight key meetings and busy days',
    '2. *Weekend Catch-up* — What happened over the weekend: DMs, emails, channel activity, meetings',
    '3. *Week Priorities* — Open tasks organized by priority, flag anything with deadlines this week',
    '4. *Decisions Needed* — Anything pending Daniel\'s input or approval',
    '',
    'This is a strategic overview for the week — help Daniel plan and prioritize.',
    'Keep it scannable, use bullet points, bold key items.',
    'If a data source is unavailable, skip that section silently.',
    'End with a brief note to set the tone for the week.',
  ].join('\n');

  try {
    const response = await getClient().messages.create({
      model: BRIEFING_MODEL,
      max_tokens: 3072,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Here is the data gathered for this week's Monday overview:\n\n${dataSummary}`,
        },
      ],
    });

    const briefingText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    logger.info(
      { briefingLength: briefingText.length, dataSources: dataSections.length },
      'Weekly briefing generated',
    );

    await postBriefing(`:calendar: *Weekly Overview*\n\n${briefingText}`);
    logger.info('Weekly briefing sent to Daniel');

    await persistBriefing('weekly', briefingText, dataSections.length);
    return briefingText;
  } catch (err) {
    logger.error({ err }, 'Failed to generate weekly briefing');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerBriefingJobs(): void {
  registerJob(
    'weekly-briefing',
    '0 8 * * 1', // 8am Monday
    'Europe/Berlin',
    async () => { await generateWeeklyBriefing(); },
  );

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
