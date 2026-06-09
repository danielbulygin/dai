/**
 * Monday meeting-prep automation (Ada → Ace pipeline).
 *
 * Replaces Nina's manual Monday ritual (she used to ask Ada per client in #ada,
 * then hand-copy the condensed result into the Notion agenda):
 *
 * 1. 08:00 Mon Berlin — `runMondayThreeDayDrafts()`: Ada analyzes Fri–Sun for every
 *    media-buying client and posts a highlights/lowlights draft per client in #ada,
 *    tagging Nina. Nina edits a draft instead of authoring her client updates.
 *
 * 2. 09:30 Mon Berlin — `runMondayAgendaBlocks()`: after Ace's agenda sweep has
 *    created the `{Client} - weekly` pages, Ada produces a 7-day agenda-ready block
 *    per client and posts it in #agent-office tagging Ace. Ace (aot-agents) triggers
 *    on the real mention and surgically merges the block into sections
 *    1b (Current Performance) + 2 (Media Buying Updates) of that week's agenda page.
 *
 * Both jobs post each client as its OWN top-level message (fresh post, never a
 * stream-edit — edits fire `message_changed`, which agent listeners ignore).
 * Failures are per-client: one client erroring never blocks the rest.
 */

import { runAgent } from '../agents/runner.js';
import { getDedicatedBotClient } from '../slack/dedicated-bots.js';
import { AGENT_OFFICE_CHANNEL_ID, AGENT_DIRECTORY } from '../agents/agent-directory.js';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';

const ADA_CHANNEL = (env as unknown as Record<string, string | undefined>).ADA_UPLOAD_CHECK_CHANNEL_ID || 'C0AHX94CBF0';
const NINA = AGENT_DIRECTORY.find((a) => a.name === 'Nina')!.slackUserId;
const ACE = AGENT_DIRECTORY.find((a) => a.name === 'Ace')!.slackUserId;

/** The media-buying client roster for Monday prep (code → name Ada's tools resolve). */
export const MONDAY_PREP_CLIENTS: Array<{ code: string; name: string }> = [
  { code: 'BFM', name: 'Brain.fm' },
  { code: 'LA', name: 'Laori' },
  { code: 'TL', name: 'Teethlovers' },
  { code: 'SLB', name: 'Slumber' },
  { code: 'FPL', name: 'Forpeople' },
  { code: 'JVA', name: 'JV Academy' },
  { code: 'PL', name: 'Press London' },
];

/**
 * Per-client additions appended to BOTH Monday prompts. Keyed by client code.
 * LA: the client tracks Triple Whale net profit in the weekly report, so every
 * Monday block must carry it (get_triplewhale_summary, window matched to the read).
 */
const CLIENT_PROMPT_EXTRAS: Record<string, string> = {
  LA:
    ` Laori also reports blended profitability from Triple Whale: call get_triplewhale_summary with startDate/endDate matching this exact analysis window and add ONE line at the end of the first section: ` +
    `"Net profit (Triple Whale): €X (prev €Y)" using totalNetProfit current/previous. If net profit is negative or POAS is below 1, append a Lowlight bullet naming the disconnect vs Meta ROAS.`,
};

// Metric passports: the 2026-06-08 Monday reads showed two different values
// both labeled "blended ROAS" (one Meta-attributed, one Triple Whale) in one
// message — reads as a math error. Every number must carry its source.
const METRIC_PASSPORT_RULE =
  ` METRIC LABELING (MANDATORY): every metric states its source — "Meta ROAS"/"Meta CPA" for Meta-attributed numbers, "TW blended ROAS"/"TW net profit" for Triple Whale, "SF CPA" for Salesforce/Domo. ` +
  `NEVER use the bare word "blended" for a Meta-attributed number. Never present two differently-sourced values under the same label. When two sources disagree, show both WITH their labels and one clause on why they differ. ` +
  `Each section uses ONE consistent comparison window and superlatives name their axis ("most purchases" vs "best CPA" — not "strongest day").`;

const THREE_DAY_PROMPT = (name: string, code: string) =>
  `Run your standard weekend read for ${name} (client code ${code}): analyze the last 3 days (Friday, Saturday, Sunday) and give highlights and lowlights of the performance, plus anything interesting happening. ` +
  `This is the Monday-morning draft Nina turns into her client update, so keep it TIGHT and client-translatable, in EXACTLY this structure (the deliverable must start with the literal line "*Summary*"):\n` +
  `*Summary*\n2-3 lines vs the client's target KPI.\n*✨ Highlights*\n3-4 bullets, numbers first.\n*📉 Lowlights*\n2-3 bullets, numbers first.\n` +
  `No greetings, no sign-off, no questions back. If the account had no meaningful spend in the window, say so in the Summary instead of padding.` +
  METRIC_PASSPORT_RULE +
  (CLIENT_PROMPT_EXTRAS[code] ?? '');

const AGENDA_BLOCK_PROMPT = (name: string, code: string) =>
  `Produce the Tuesday-meeting agenda block for ${name} (client code ${code}): analyze the last 7 days including the funnel, and output EXACTLY this structure (it goes verbatim into the Notion agenda):\n` +
  `*Current Performance*\n2-3 lines: blended performance vs the client's target KPI, spend, conversions, last-3-day trend.\n` +
  `*✨ Highlights*\n3-4 campaign-level bullets, numbers first.\n` +
  `*📉 Lowlights*\n2-3 bullets, numbers first.\n` +
  `*Funnel note*\n1 line if anything is leaking; otherwise "No funnel anomalies."\n` +
  `No greetings, no sign-off, no narrative outside the structure.` +
  METRIC_PASSPORT_RULE +
  (CLIENT_PROMPT_EXTRAS[code] ?? '');

interface JobResult {
  client: string;
  ok: boolean;
  error?: string;
}

async function runClientAnalysis(prompt: string, code: string, marker: string): Promise<string> {
  const result = await runAgent({
    agentId: 'ada',
    userMessage: prompt,
    userId: 'system',
    channelId: `internal-monday-prep-${code.toLowerCase()}`,
  });
  const full = result.response?.trim() ?? '';
  // The runner concatenates EVERY turn's text, so the deliverable is preceded by
  // working narration ("I'll pull the data...", "Computing..."). Slice from the
  // last occurrence of the template's opening marker; fall back to the full text.
  const idx = full.lastIndexOf(marker);
  return idx > 0 ? full.slice(idx).trim() : full;
}

/** 08:00 Mon — per-client 3-day drafts into #ada for Nina. `only` filters client codes (testing). */
export async function runMondayThreeDayDrafts(only?: string[]): Promise<JobResult[]> {
  const client = getDedicatedBotClient('ada');
  const results: JobResult[] = [];
  const roster = only?.length
    ? MONDAY_PREP_CLIENTS.filter((c) => only.includes(c.code))
    : MONDAY_PREP_CLIENTS;

  for (const c of roster) {
    try {
      const analysis = await runClientAnalysis(THREE_DAY_PROMPT(c.name, c.code), c.code, '*Summary*');
      if (!analysis) throw new Error('empty analysis');
      await client.chat.postMessage({
        channel: ADA_CHANNEL,
        text: `*${c.name} — Monday weekend read (Fri–Sun)* <@${NINA}>\n\n${analysis}\n\n_Draft for your Monday client update — edit and ship. Reply in this thread for follow-ups._`,
        unfurl_links: false,
      });
      results.push({ client: c.code, ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, client: c.code }, 'Monday 3-day draft failed');
      results.push({ client: c.code, ok: false, error: msg });
    }
  }

  await postRunSummary('Monday 08:00 weekend-read drafts', results, ADA_CHANNEL);
  return results;
}

/** 09:30 Mon — per-client 7-day agenda blocks into #agent-office, handed to Ace. `only` filters client codes (testing). */
export async function runMondayAgendaBlocks(only?: string[]): Promise<JobResult[]> {
  const client = getDedicatedBotClient('ada');
  const results: JobResult[] = [];
  const roster = only?.length
    ? MONDAY_PREP_CLIENTS.filter((c) => only.includes(c.code))
    : MONDAY_PREP_CLIENTS;

  for (const c of roster) {
    try {
      const block = await runClientAnalysis(AGENDA_BLOCK_PROMPT(c.name, c.code), c.code, '*Current Performance*');
      if (!block) throw new Error('empty agenda block');
      await client.chat.postMessage({
        channel: AGENT_OFFICE_CHANNEL_ID,
        text:
          `*${c.name} (${c.code}) — performance block for this week's agenda*\n\n${block}\n\n` +
          `<@${ACE}> please merge this into this week's *${c.name} - weekly* page in the Client Meetings database: ` +
          `the *Current Performance* lines into section *1b. Current Performance*, the Highlights/Lowlights/Funnel bullets into section *2. Media Buying Updates*, ` +
          `with the note _"(per Ada, auto — Nina to verify)"_ under the section 2 heading. Keep my wording verbatim. ` +
          `If no agenda page exists for this week, reply here flagging it instead.`,
        unfurl_links: false,
      });
      results.push({ client: c.code, ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, client: c.code }, 'Monday agenda block failed');
      results.push({ client: c.code, ok: false, error: msg });
    }
  }

  await postRunSummary('Monday 09:30 agenda blocks → Ace', results, AGENT_OFFICE_CHANNEL_ID);
  return results;
}

/** One-line run summary so silent partial failures are visible (no silent caps). */
async function postRunSummary(label: string, results: JobResult[], channel: string): Promise<void> {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    logger.info({ label, count: results.length }, 'Monday prep job complete — all clients ok');
    return;
  }
  const client = getDedicatedBotClient('ada');
  await client.chat.postMessage({
    channel,
    text: `⚠️ *${label}*: ${failed.length}/${results.length} clients failed — ${failed
      .map((f) => `${f.client} (\`${f.error?.slice(0, 80)}\`)`)
      .join(', ')}. Logs: \`journalctl -u dai | grep monday\`.`,
  });
}
