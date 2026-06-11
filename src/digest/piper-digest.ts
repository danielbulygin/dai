/**
 * Piper morning digest (master plan 2026-06-09 §2.3 — deterministic).
 *
 * DETERMINISTIC — no runAgent/LLM call. The numbers live in the SQL brain:
 * piper_digest_payload() (bmad Supabase) returns one jsonb payload and this
 * module is pure data → render. The renderer does ZERO arithmetic beyond
 * counting/filtering payload arrays (the one sanctioned sum: total real
 * overdue for the headline). Same payload in → byte-identical digest out.
 *
 * Style: calm, status-first, Slack mrkdwn, every code hyperlinked
 * (<url|CODE>), NEVER em dashes (use - or ·).
 *
 * Triggered by the droplet systemd timer → POST /api/cron/piper-digest
 * (Mon-Fri 09:00 ET). Standalone: `pnpm digest:piper [--post]`.
 */

import { WebClient } from '@slack/web-api';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { getSupabase } from '../integrations/supabase.js';
import { getDedicatedBotClient } from '../slack/dedicated-bots.js';

// ---------------------------------------------------------------------------
// Payload types (shape of piper_digest_payload())
// ---------------------------------------------------------------------------

export interface DigestOverdueItem {
  task_id: string;
  task_name: string | null;
  task_url: string | null;
  ad_set_code: string | null;
  ad_set_url: string | null;
  owner: string | null;
  derived_status: string | null;
  bucket: string | null;
  days_overdue: number | null;
  delivery_date: string | null;
}

export interface DigestCadence {
  target_per_week: number | null;
  provisional: boolean | null;
  gate_done_28d: number | null;
  tracking_pct: number | null;
}

export interface DigestClient {
  client_code: string;
  live_sets: number;
  working: number;
  sitting: number;
  external: number;
  data_gap: number;
  coverage_pct: number | null;
  real_overdue: number;
  queued_behind: number;
  zombie_debt: number;
  gate_done_7d: number;
  top_overdue: DigestOverdueItem[];
  cadence: DigestCadence | null;
}

/** Phase 4 LOOKING AHEAD item (piper_digest_payload()->looking_ahead, <=3). */
export interface DigestLookingAhead {
  kind: 'capacity' | 'stage_lag' | 'cadence';
  // capacity
  person?: string;
  ratio?: number;
  open_near?: number;
  weekly_rate?: number;
  window_weeks?: number;
  // stage_lag
  ad_set_code?: string;
  client_code?: string;
  bucket?: string;
  frontier_task?: string | null;
  owner?: string | null;
  days?: number;
  window_capped?: boolean;
  bucket_p50?: number;
  // cadence
  pct?: number;
  avg_4w?: number;
  target_per_week?: number;
}

export interface DigestPayload {
  generated_at: string | null;
  freshness: string | null;
  qc_sitting_sets: number | null;
  zombie_debt_tasks: number | null;
  clients: DigestClient[];
  people_bottlenecks: { person: string; open: number; overdue: number }[];
  data_quality_drift: { metric: string; now: number; week_ago: number }[];
  looking_ahead?: DigestLookingAhead[];
}

export async function fetchDigestPayload(): Promise<DigestPayload> {
  const { data, error } = await getSupabase().rpc('piper_digest_payload');
  if (error) throw new Error(`piper_digest_payload failed: ${error.message}`);
  if (!data) throw new Error('piper_digest_payload returned no payload.');
  return data as DigestPayload;
}

// ---------------------------------------------------------------------------
// Rendering — pure template, zero recomputation
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function mrkdwnEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slackLink(url: string | null, label: string): string {
  const text = mrkdwnEscape(label);
  return url ? `<${url}|${text}>` : text;
}

function headerDate(d: Date): string {
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function utcHHMM(iso: string | null): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '??:??';
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

const DETAIL_THRESHOLD = 10; // real_overdue >= 10 earns a detail block
const MAX_DETAIL_BLOCKS = 4;
const MAX_ITEMS_PER_BLOCK = 3;
const QC_SIGNAL_THRESHOLD = 5;

/** `<task_url|Task Name> - <ad_set_url|CODE> · <owner> · <X>d over` */
function renderOverdueItem(item: DigestOverdueItem): string {
  const task = slackLink(item.task_url, item.task_name ?? item.task_id);
  const parts: string[] = [task];
  const segs: string[] = [];
  if (item.ad_set_code) segs.push(slackLink(item.ad_set_url, item.ad_set_code));
  segs.push(item.owner ?? 'unassigned');
  if (item.days_overdue !== null && item.days_overdue !== undefined) {
    segs.push(`${item.days_overdue}d over`);
  }
  return `• ${parts[0]} - ${segs.join(' · ')}`;
}

function renderPingLine(item: DigestOverdueItem): string | null {
  const owner = item.owner?.trim();
  if (!owner || owner.toLowerCase() === 'unassigned') return null;
  const code = item.ad_set_code ?? 'this set';
  const task = item.task_name ?? 'the task';
  const days = item.days_overdue !== null && item.days_overdue !== undefined ? `${item.days_overdue}d` : 'past';
  return `  Suggest pinging ${owner}: '${code} ${task} is ${days} past due - can you move it today?'`;
}

function renderLookingAhead(item: DigestLookingAhead): string {
  if (item.kind === 'capacity') {
    return `• ${item.person}'s next-7-day load is ${item.ratio}x their completion rate (${item.open_near} open vs ~${item.weekly_rate}/wk observed over ${item.window_weeks}w).`;
  }
  if (item.kind === 'stage_lag') {
    const days = item.window_capped ? `${item.days}d+` : `${item.days}d`;
    return `• ${item.ad_set_code} (${item.client_code}) has sat in ${item.bucket} ${days} - typical for that stage is ${item.bucket_p50}d${item.owner ? ` - frontier with ${item.owner}` : ''}.`;
  }
  if (item.kind === 'cadence') {
    return `• ${item.client_code} tracking ${item.pct}% of contract (${item.avg_4w}/wk vs ${item.target_per_week} target, 4-full-week basis).`;
  }
  return `• ${JSON.stringify(item)}`;
}

export function renderDigest(payload: DigestPayload): string {
  const clients = payload.clients ?? [];
  const now = payload.generated_at ? new Date(payload.generated_at) : new Date();

  const heavy = clients.filter((c) => c.real_overdue >= DETAIL_THRESHOLD);
  const detail = heavy.slice(0, MAX_DETAIL_BLOCKS);
  const heavyRest = heavy.slice(MAX_DETAIL_BLOCKS);
  const lighter = clients.filter((c) => c.real_overdue > 0 && c.real_overdue < DETAIL_THRESHOLD);
  const allClear = clients.filter((c) => c.real_overdue === 0);

  // The sanctioned sums: headline totals (spec: "total real-overdue across clients").
  const totalOverdue = clients.reduce((sum, c) => sum + (c.real_overdue ?? 0), 0);
  const totalQueued = clients.reduce((sum, c) => sum + (c.queued_behind ?? 0), 0);
  const worst = clients[0]; // payload is sorted by real_overdue desc

  const lines: string[] = [];
  lines.push(`:spiral_calendar_pad: *Morning Pipeline Digest - ${headerDate(now)}*`);
  if (worst && totalOverdue > 0) {
    lines.push(
      `${totalOverdue} actionable overdue tasks across ${clients.length} clients` +
        (totalQueued > 0 ? ` (+${totalQueued} queued behind blocks)` : '') +
        ` · ${worst.client_code} is the heaviest with ${worst.real_overdue}.`,
    );
  } else {
    lines.push(`Nothing actionable-overdue across ${clients.length} clients · all clear.`);
  }

  for (const [i, client] of detail.entries()) {
    const icon = i === 0 ? ':red_circle:' : ':large_orange_circle:';
    lines.push('');
    lines.push(
      `${icon} *${client.client_code} - ${client.real_overdue} actionable overdue${
        client.queued_behind > 0 ? ` (+${client.queued_behind} queued behind)` : ''
      }.*`,
    );
    const items = (client.top_overdue ?? []).slice(0, MAX_ITEMS_PER_BLOCK);
    for (const item of items) {
      lines.push(renderOverdueItem(item));
    }
    const worstItem = items[0];
    if (worstItem) {
      const ping = renderPingLine(worstItem);
      if (ping) lines.push(ping);
    }
  }

  if (heavyRest.length > 0) {
    lines.push('');
    lines.push(`*Also overdue:* ${heavyRest.map((c) => `${c.client_code} ${c.real_overdue}`).join(', ')}`);
  }
  if (lighter.length > 0) {
    if (heavyRest.length === 0) lines.push('');
    lines.push(`*Lighter:* ${lighter.map((c) => `${c.client_code} ${c.real_overdue}`).join(', ')}`);
  }
  if (allClear.length > 0) {
    if (heavyRest.length === 0 && lighter.length === 0) lines.push('');
    lines.push(`*All clear:* ${allClear.map((c) => c.client_code).join(', ')}`);
  }

  const belowTarget = clients.filter(
    (c) => c.cadence && c.cadence.tracking_pct !== null && c.cadence.tracking_pct !== undefined && c.cadence.tracking_pct < 90,
  );
  if (belowTarget.length > 0) {
    lines.push('');
    lines.push(
      `*Cadence below target (4 full wks):* ${belowTarget
        .map((c) => `${c.client_code} ${c.cadence!.tracking_pct}%${c.cadence!.provisional ? ' (prov.)' : ''}`)
        .join(', ')}`,
    );
  }

  // Phase 4.4 — LOOKING AHEAD: <=3 threshold-gated predictive lines, all
  // computed in SQL (piper_stage_lag / piper_capacity_read / piper_cadence_read).
  const ahead = payload.looking_ahead ?? [];
  if (ahead.length > 0) {
    lines.push('');
    lines.push('*LOOKING AHEAD:*');
    for (const item of ahead.slice(0, 3)) {
      lines.push(renderLookingAhead(item));
    }
  }

  if ((payload.qc_sitting_sets ?? 0) > QC_SIGNAL_THRESHOLD) {
    lines.push('');
    lines.push(`*${payload.qc_sitting_sets} sets sitting in QC with no pickup.*`);
  }

  if ((payload.data_quality_drift ?? []).length > 0) {
    lines.push('');
    lines.push(
      `*Data-quality drift:* ${payload.data_quality_drift
        .map((d) => `${d.metric} ${d.week_ago} -> ${d.now}`)
        .join(' · ')}.`,
    );
  }

  if ((payload.zombie_debt_tasks ?? 0) > 0) {
    lines.push('');
    lines.push(
      `_${payload.zombie_debt_tasks} past-due tasks older than 90d excluded as zombie debt - hygiene queue, not action._`,
    );
  }

  lines.push('');
  lines.push(`_brain as of ${utcHHMM(payload.freshness)} UTC · every number reproducible by SQL (piper_digest_payload)_`);
  lines.push('Board: https://bmad-lac.vercel.app/pipeline');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Runner — posting mechanics unchanged from the LLM era
// ---------------------------------------------------------------------------

export interface DigestResult {
  posted: boolean;
  channel: string | null;
  ts?: string;
  digest: string;
  /** Always 0 now — the digest is deterministic, no agent turns. Kept for caller compat. */
  turns: number;
}

/**
 * Fetch the brain payload, render the digest, and (unless dryRun) post it to
 * #piper as Piper. Channel resolves from opts.channelId ?? env.PIPER_CHANNEL_ID.
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

  const started = Date.now();
  logger.info({ channel, dryRun }, 'Piper digest: fetching brain payload');

  const payload = await fetchDigestPayload();
  const digest = renderDigest(payload);

  logger.info(
    { clients: payload.clients?.length ?? 0, chars: digest.length, ms: Date.now() - started },
    'Piper digest: rendered',
  );

  if (dryRun || !channel) {
    return { posted: false, channel, digest, turns: 0 };
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
    turns: 0,
  };
}
