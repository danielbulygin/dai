/**
 * Piper "My Real Moves" post (master plan 2026-06-09 §3.2 — Tier 1 surface).
 *
 * DETERMINISTIC — no LLM call. The ranking lives in the SQL brain
 * (piper_my_moves_all(), bmad Supabase); this module is pure data → render:
 *   - ONE parent message to #piper: header + one summary line per person +
 *     correction-loop footer + freshness line.
 *   - One THREAD REPLY per person with their ranked move list, every code
 *     hyperlinked to Notion.
 *
 * Calm channel post: bold display names, NO <@…> mentions, no em dashes.
 *
 * Triggered by the droplet timer → POST /api/cron/piper-my-moves, or
 * standalone: `pnpm digest:piper-moves [--post]`.
 */

import { WebClient } from '@slack/web-api';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { getSupabase } from '../integrations/supabase.js';
import { getDedicatedBotClient } from '../slack/dedicated-bots.js';

// ---------------------------------------------------------------------------
// Data layer (shared with the get_my_moves agent tool)
// ---------------------------------------------------------------------------

/** One row from piper_my_moves_all() / piper_my_moves(p_person_id). */
export interface MyMoveRow {
  person_id: string;
  person_display: string | null;
  person_slack_id: string | null;
  rank: number;
  task_id: string;
  task_name: string | null;
  task_url: string | null;
  canonical_type: string | null;
  derived_status: string; // 'in_progress' | 'ready' | 'ready*'
  notion_blocked: boolean | null; // ready*: Notion still says Blocked, predecessor looks done
  due_date: string | null; // YYYY-MM-DD
  days_overdue: number | null;
  days_in_status: number | null;
  ad_set_code: string | null;
  ad_set_url: string | null;
  client_code: string | null;
  bucket: string | null;
  ad_delivery_date: string | null;
  data_confidence: string | null;
}

export async function fetchMyMovesAll(): Promise<MyMoveRow[]> {
  const { data, error } = await getSupabase().rpc('piper_my_moves_all');
  if (error) throw new Error(`piper_my_moves_all failed: ${error.message}`);
  return (data ?? []) as MyMoveRow[];
}

export async function fetchMyMovesFor(personId: string): Promise<MyMoveRow[]> {
  const { data, error } = await getSupabase().rpc('piper_my_moves', { p_person_id: personId });
  if (error) throw new Error(`piper_my_moves failed: ${error.message}`);
  return (data ?? []) as MyMoveRow[];
}

/**
 * Freshness of the derived state behind the list (max piper_task_state.updated_at).
 * Falls back to null — caller substitutes generation time.
 */
export async function fetchDerivedStateFreshness(): Promise<Date | null> {
  try {
    const { data, error } = await getSupabase()
      .from('piper_task_state')
      .select('updated_at')
      .order('updated_at', { ascending: false })
      .limit(1);
    const latest = data?.[0];
    if (error || !latest) return null;
    const d = new Date(latest.updated_at as string);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Human labels for the engine-computed bucket slugs (piper_ad_set_state.bucket). */
export const BUCKET_LABELS: Record<string, string> = {
  briefing: 'Briefing',
  brief_with_client: 'Brief with client',
  preprod_shoot: 'Pre-prod & shoot',
  waiting_footage: 'Waiting for footage',
  editing: 'Editing',
  qc_internal: 'QC & sign-off',
  delivery_approval: 'Delivery & approval',
  launch: 'Launch',
};

export function bucketLabel(bucket: string | null): string {
  if (!bucket) return 'No bucket';
  return BUCKET_LABELS[bucket] ?? bucket.replace(/_/g, ' ');
}

function statusIcon(derivedStatus: string): string {
  return derivedStatus === 'in_progress' ? ':hammer_and_wrench:' : ':hourglass_flowing_sand:';
}

/** Escape Slack mrkdwn control chars in free text (task names etc.). */
function mrkdwnEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function shortDate(iso: string): string {
  // ISO date-only strings parse as UTC midnight — read UTC fields to stay stable.
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function headerDate(now: Date): string {
  return `${WEEKDAYS[now.getUTCDay()]} ${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]}`;
}

function slackLink(url: string | null, label: string): string {
  const text = mrkdwnEscape(label);
  return url ? `<${url}|${text}>` : text;
}

/** `1. :hammer_and_wrench: <task_url|Task Name> - <ad_set_url|CODE> · due Jun 4 (6d overdue) · QC & sign-off` */
export function renderMoveRow(row: MyMoveRow): string {
  const parts: string[] = [];
  parts.push(slackLink(row.task_url, row.task_name ?? row.task_id));

  const segs: string[] = [];
  if (row.ad_set_code) segs.push(slackLink(row.ad_set_url, row.ad_set_code));
  if (row.due_date) {
    const overdue = row.days_overdue && row.days_overdue > 0 ? ` (${row.days_overdue}d overdue)` : '';
    segs.push(`due ${shortDate(row.due_date)}${overdue}`);
  } else {
    segs.push('no due date');
  }
  segs.push(bucketLabel(row.bucket));
  // ready*: Notion still says Blocked but the predecessor looks done — say so
  // instead of silently disagreeing with what the doer sees in Notion.
  if (row.notion_blocked) segs.push("_Notion says Blocked - looks stale; reply 'still blocked' if not_");

  return `${row.rank}. ${statusIcon(row.derived_status)} ${parts[0]} - ${segs.join(' · ')}`;
}

interface PersonBlock {
  personId: string;
  display: string;
  moves: MyMoveRow[];
  overdueCount: number;
}

function groupByPerson(rows: MyMoveRow[]): PersonBlock[] {
  const byPerson = new Map<string, PersonBlock>();
  for (const row of rows) {
    let block = byPerson.get(row.person_id);
    if (!block) {
      block = {
        personId: row.person_id,
        display: row.person_display ?? row.person_id,
        moves: [],
        overdueCount: 0,
      };
      byPerson.set(row.person_id, block);
    }
    block.moves.push(row);
    if (row.days_overdue && row.days_overdue > 0) block.overdueCount += 1;
  }
  for (const block of byPerson.values()) {
    block.moves.sort((a, b) => a.rank - b.rank);
  }
  // Most-overdue people first, then most moves, then name — stable, scannable.
  return [...byPerson.values()].sort(
    (a, b) =>
      b.overdueCount - a.overdueCount ||
      b.moves.length - a.moves.length ||
      a.display.localeCompare(b.display),
  );
}

export interface MyMovesRender {
  /** The parent channel message. */
  parent: string;
  /** One thread reply per person, in posting order. */
  threads: { personId: string; display: string; text: string }[];
  peopleCount: number;
  moveCount: number;
}

export function renderMyMoves(rows: MyMoveRow[], opts: { now?: Date; freshness?: Date | null } = {}): MyMovesRender {
  const now = opts.now ?? new Date();
  const blocks = groupByPerson(rows);

  const summaryLines = blocks.map((b) => {
    const moves = `${b.moves.length} move${b.moves.length === 1 ? '' : 's'}`;
    const overdue = b.overdueCount > 0 ? ` (${b.overdueCount} overdue)` : '';
    return `*${mrkdwnEscape(b.display)}* - ${moves}${overdue}`;
  });

  const freshness = opts.freshness ?? now;
  const hh = String(freshness.getUTCHours()).padStart(2, '0');
  const mm = String(freshness.getUTCMinutes()).padStart(2, '0');

  const parent = [
    `:dart: *My Real Moves - ${headerDate(now)}*`,
    '',
    ...(summaryLines.length > 0 ? summaryLines : ['No moves on anyone\'s board right now - all clear.']),
    '',
    "Reply in your thread: 'done', 'not mine', 'still blocked', or 'blocked on client' and I'll update Notion. Full board: https://bmad-lac.vercel.app/pipeline",
    `_derived state as of ${hh}:${mm} UTC_`,
  ].join('\n');

  const threads = blocks.map((b) => ({
    personId: b.personId,
    display: b.display,
    text: [`*${mrkdwnEscape(b.display)}'s moves*`, ...b.moves.map(renderMoveRow)].join('\n'),
  }));

  return { parent, threads, peopleCount: blocks.length, moveCount: rows.length };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface MyMovesResult {
  posted: boolean;
  channel: string | null;
  parentTs?: string;
  peopleCount: number;
  moveCount: number;
  /** Full rendered output (parent + every thread) — what a dry-run prints. */
  text: string;
}

export async function runPiperMyMoves(
  opts: { post?: boolean; channelId?: string } = {},
): Promise<MyMovesResult> {
  const post = opts.post ?? false;
  const channel = opts.channelId ?? env.PIPER_CHANNEL_ID ?? null;

  if (post && !channel) {
    throw new Error('No channel: set PIPER_CHANNEL_ID (the #piper channel ID) or pass channelId.');
  }

  logger.info({ channel, post }, 'Piper my-moves: fetching');
  const [rows, freshness] = await Promise.all([fetchMyMovesAll(), fetchDerivedStateFreshness()]);
  const render = renderMyMoves(rows, { freshness });

  const text = [render.parent, ...render.threads.map((t) => t.text)].join('\n\n---\n\n');
  logger.info(
    { people: render.peopleCount, moves: render.moveCount, chars: text.length },
    'Piper my-moves: rendered',
  );

  if (!post || !channel) {
    return { posted: false, channel, peopleCount: render.peopleCount, moveCount: render.moveCount, text };
  }

  // Post AS Piper. Same rationale as piper-digest.ts: build the client straight
  // from PIPER_BOT_TOKEN so standalone runs don't silently post as the main bot.
  let client: WebClient;
  if (env.PIPER_BOT_TOKEN) {
    client = new WebClient(env.PIPER_BOT_TOKEN);
  } else {
    logger.warn('PIPER_BOT_TOKEN unset — my-moves will post as the main DAI bot, not Piper.');
    client = getDedicatedBotClient('piper');
  }

  const parentMsg = await client.chat.postMessage({
    channel,
    text: render.parent,
    unfurl_links: false,
    unfurl_media: false,
  });
  const parentTs = parentMsg.ts;
  if (!parentTs) throw new Error('Parent my-moves post returned no ts — cannot thread replies.');

  for (const thread of render.threads) {
    await client.chat.postMessage({
      channel,
      thread_ts: parentTs,
      text: thread.text,
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  logger.info({ channel, ts: parentTs, threads: render.threads.length }, 'Piper my-moves: posted');

  return {
    posted: true,
    channel,
    parentTs,
    peopleCount: render.peopleCount,
    moveCount: render.moveCount,
    text,
  };
}
