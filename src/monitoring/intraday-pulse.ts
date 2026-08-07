/**
 * The intraday pulse — Ada's between-briefs ping (media-buyer vision, Loop 1½).
 *
 * The morning brief judges yesterday. This job does NOT judge anything: it
 * fires only when something EVENT-WORTHY happened on a pilot account TODAY,
 * and it says so as an event ("as of this afternoon"), never as a day verdict.
 * A partial day is never judged as a day — that is the whole discipline here.
 *
 * Total silence is the default. No scheduled noise, no "nothing to report"
 * message, no daily summary. If the accounts are quiet, #ada stays quiet.
 *
 * The three v1 events, per account, over TODAY's ad_daily rows (the warehouse
 * re-syncs hourly, so today-partial rows exist by mid-morning):
 *   1. a new ad started spending today       → 🚀 + open its launch watch NOW
 *   2. money out, nothing back (intraday)    → 💸 spend ≥ 2× the expected CPA
 *   3. the account went dark                 → 🌑 spent yesterday, nothing today
 *
 * "Today" is the ACCOUNT's local day (clients.timezone), never the server day —
 * the same trap the morning brief documents. Currency is per account too.
 *
 * Dedupe: the job runs twice a day. Every posted event writes an ada_insights
 * row with source 'intraday-pulse' and evidence.date = the account-local today;
 * the next pulse reads those back and stays quiet about what it already said.
 */

import { getSupabase } from '../integrations/supabase.js';
import { getDaiSupabase } from '../integrations/dai-supabase.js';
import { getDedicatedBotClient } from '../slack/dedicated-bots.js';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import {
  PILOT_CLIENTS,
  accountYesterday,
  detectNewAds,
  fetchAdDaily,
  fetchClientGroup,
  fetchConfigTargets,
} from './agency-morning-brief.js';

// The brief keeps its row shapes private; derive them from the exported
// fetchers so the two files can never drift apart silently.
type ClientRow = Awaited<ReturnType<typeof fetchClientGroup>>[number];
type AdDay = Awaited<ReturnType<typeof fetchAdDaily>>[number];
type NewAd = Awaited<ReturnType<typeof detectNewAds>>[number];

// #ada — same channel as the morning brief.
const DEFAULT_CHANNEL = 'C0AHX94CBF0';

/** Enough history for today + yesterday + the 3-day "nothing back" lookback. */
const HISTORY_DAYS = 5;

/** An ad is worth interrupting for when it has burned this many expected CPAs. */
const MONEY_OUT_MULTIPLE = 2;

/** Zero-purchase lookback for rule 2, in days before today. */
const MONEY_OUT_LOOKBACK_DAYS = 3;

/**
 * Rule 1's materiality floor. A launch is news once it is actually delivering —
 * a £0.05 trickle is not an event, it is the auction clearing its throat. Scaled
 * to the account so a $7k/day account and a $200/day account both get a floor
 * that means "this is really running", with an absolute floor for tiny days.
 * Anything quieter still surfaces in tomorrow's What's-New.
 */
const NEW_AD_MIN_SPEND_SHARE = 0.005;
const NEW_AD_MIN_SPEND_ABS = 1;

/** The account must be past this local hour before "dark" is a fair claim. */
const DARK_AFTER_HOUR = 12;

/** Per account, per pulse — an event flood is noise, not a pulse. */
const MAX_EVENTS_PER_KIND = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PulseEventKind = 'new-ad' | 'money-out' | 'account-dark';

export interface PulseEvent {
  clientCode: string;
  /** The pilot client's name — the Slack group header. */
  pilotName: string;
  /** This ad account's display name, used inside the line. */
  accountLabel: string;
  adAccountId: string | null;
  kind: PulseEventKind;
  entityLevel: 'ad' | 'account';
  entityId: string;
  entityName: string;
  /** The ACCOUNT-local day the event is about. */
  date: string;
  line: string;
  evidence: Record<string, unknown>;
}

export interface IntradayPulseResult {
  events: PulseEvent[];
  /** The composed Slack message, or '' when nothing was event-worthy. */
  text: string;
  posted: boolean;
  channel: string | null;
  insightsWritten: number;
}

export interface IntradayPulseOptions {
  post?: boolean;
  now?: Date;
  pilots?: string[];
  /**
   * Write the dedupe + launch-watch rows. Defaults to `post` — a dry run must
   * not silently burn the dedupe slot for a message nobody ever saw.
   */
  writeToLedger?: boolean;
}

// ---------------------------------------------------------------------------
// Account-local clock + money (the two standing traps)
// ---------------------------------------------------------------------------

/** The account's local "today" as YYYY-MM-DD. */
export function accountToday(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The account's local wall clock as HH:MM (24h). */
export function accountClock(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}

/** The account's local hour, 0–23. */
export function accountHour(timeZone: string, now: Date = new Date()): number {
  return Number(accountClock(timeZone, now).slice(0, 2));
}

/** 'YYYY-MM-DD' shifted by whole days, timezone-free (noon anchor). */
function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function money(value: number, currency: string, decimals?: number): string {
  const d = decimals ?? (Number.isInteger(value) ? 0 : value >= 100 ? 0 : 2);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    }).format(value);
  } catch {
    return `${value.toFixed(d)} ${currency}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Dedupe key: one event of one kind per entity per account-local day. */
export function pulseKey(entityId: string, kind: PulseEventKind): string {
  return `${entityId}::${kind}`;
}

// ---------------------------------------------------------------------------
// The three event detectors (pure — rows + params in, claims out)
// ---------------------------------------------------------------------------

export interface AccountPulseInput {
  clientCode: string;
  pilotName: string;
  accountLabel: string;
  adAccountId: string | null;
  currency: string;
  /** Account-local today / yesterday, YYYY-MM-DD. */
  today: string;
  yesterday: string;
  /** Account-local wall clock, 'HH:MM'. */
  asOfLocal: string;
  hourLocal: number;
  /** ad_daily rows covering at least today − HISTORY_DAYS. */
  ads: AdDay[];
  /** Output of detectNewAds() run against TODAY. */
  newAds: NewAd[];
  /** goal_bands.happy ?? client_configs targets.cpa. Null = rule 2 is skipped. */
  expectedCpa: number | null;
  yesterdaySpend: number;
  todaySpend: number;
  /** Did the warehouse write ANY row for today? No rows = a sync gap, not dark. */
  todayDataPresent: boolean;
  /** Keys already pinged today (see pulseKey). */
  alreadyPinged?: Set<string>;
}

/**
 * Rule 3, in isolation: the account spent yesterday, has recorded nothing at
 * all today, and the local day is old enough that silence means something.
 *
 * `todayDataPresent` is the honesty gate in miniature — with no rows at all we
 * cannot tell "no delivery" from "no sync", so we say nothing.
 */
export function detectAccountDark(p: {
  yesterdaySpend: number;
  todaySpend: number;
  todayDataPresent: boolean;
  hourLocal: number;
}): boolean {
  return (
    p.yesterdaySpend > 0 &&
    p.todaySpend === 0 &&
    p.todayDataPresent &&
    p.hourLocal >= DARK_AFTER_HOUR
  );
}

export interface MoneyOutHit {
  /** The primary ad id — smallest of `adIds`, so the dedupe key cannot flip. */
  adId: string;
  /** Every ad id sharing this name in the account (usually one). */
  adIds: string[];
  adName: string;
  spendToday: number;
  purchasesToday: number;
  multiple: number;
  priorPurchases: number;
}

/**
 * Meta duplicates an ad across ad sets and keeps the name — one creative,
 * several ad ids. Three identical lines read as a bug; one line carrying the
 * summed money reads as the truth, and it is the truth the buyer acts on. The
 * primary id is the lexicographically smallest so the dedupe key is stable
 * between the 13:40 and 17:40 pulses even if the spend ordering moves.
 */
function groupIdsByName<T>(
  entries: Array<{ adId: string; adName: string; item: T }>,
): Array<{ primaryId: string; adIds: string[]; name: string; items: T[] }> {
  const byName = new Map<string, Array<{ adId: string; item: T }>>();
  for (const e of entries) {
    if (!byName.has(e.adName)) byName.set(e.adName, []);
    byName.get(e.adName)!.push({ adId: e.adId, item: e.item });
  }
  return [...byName.entries()].map(([name, members]) => {
    const adIds = members.map((m) => m.adId).sort();
    return { primaryId: adIds[0]!, adIds, name, items: members.map((m) => m.item) };
  });
}

/** '"name"' or '"name" (3 ad sets)' — the fan-out is named, never hidden. */
function nameWithFanout(name: string, count: number): string {
  return count > 1
    ? `"${truncate(name, 48)}" (${count} ad sets)`
    : `"${truncate(name, 48)}"`;
}

/**
 * Rule 2: a creative that has spent ≥ 2× what a result is supposed to cost,
 * today, and returned nothing — today or in its prior 3 days. The prior window
 * is what separates "a quiet morning" from "this one does not convert".
 *
 * Judged per CREATIVE (name), not per ad id: a copy that converts pays for its
 * siblings, and a name split five ways would otherwise slip under the bar.
 */
export function detectMoneyOut(p: {
  ads: AdDay[];
  today: string;
  expectedCpa: number | null;
  excludeAdIds?: Set<string>;
}): MoneyOutHit[] {
  const { ads, today, expectedCpa } = p;
  if (!expectedCpa || expectedCpa <= 0) return [];

  const threshold = MONEY_OUT_MULTIPLE * expectedCpa;
  const windowStart = shiftDate(today, -MONEY_OUT_LOOKBACK_DAYS);

  const todayByAd = new Map<string, { name: string; spend: number; purchases: number }>();
  for (const row of ads) {
    if (row.date !== today) continue;
    const cur = todayByAd.get(row.ad_id) ?? {
      name: row.ad_name ?? row.ad_id,
      spend: 0,
      purchases: 0,
    };
    cur.spend += row.spend;
    cur.purchases += row.purchases;
    todayByAd.set(row.ad_id, cur);
  }

  const groups = groupIdsByName(
    [...todayByAd.entries()].map(([adId, t]) => ({ adId, adName: t.name, item: t })),
  );

  const hits: MoneyOutHit[] = [];
  for (const g of groups) {
    if (g.adIds.some((id) => p.excludeAdIds?.has(id))) continue;
    const spendToday = g.items.reduce((s, t) => s + t.spend, 0);
    const purchasesToday = g.items.reduce((s, t) => s + t.purchases, 0);
    if (purchasesToday !== 0) continue;
    if (spendToday < threshold) continue;
    const ids = new Set(g.adIds);
    const priorPurchases = ads
      .filter((r) => ids.has(r.ad_id) && r.date >= windowStart && r.date < today)
      .reduce((s, r) => s + r.purchases, 0);
    if (priorPurchases !== 0) continue;
    hits.push({
      adId: g.primaryId,
      adIds: g.adIds,
      adName: g.name,
      spendToday,
      purchasesToday,
      multiple: spendToday / expectedCpa,
      priorPurchases,
    });
  }
  return hits.sort((a, b) => b.spendToday - a.spendToday);
}

// ---------------------------------------------------------------------------
// The lines — event-shaped claims, never day verdicts
// ---------------------------------------------------------------------------

export function newAdLine(
  adName: string,
  clientLabel: string,
  spend: number,
  currency: string,
  adSetCount = 1,
): string {
  return `🚀 ${nameWithFanout(adName, adSetCount)} started spending on ${clientLabel} — ${money(
    spend,
    currency,
  )} so far. Watch opened; first read in the morning brief.`;
}

export function moneyOutLine(
  hit: MoneyOutHit,
  expectedCpa: number,
  currency: string,
  asOfLocal: string,
): string {
  return (
    `💸 ${money(hit.spendToday, currency)} spent, nothing back — ` +
    `${nameWithFanout(hit.adName, hit.adIds.length)} is ${hit.multiple.toFixed(1)}× your ` +
    `${money(expectedCpa, currency)} target so far today (as of ${asOfLocal} account time), ` +
    `and had no purchases in its prior ${MONEY_OUT_LOOKBACK_DAYS} days. ` +
    `Worth a look before more follows.`
  );
}

export function accountDarkLine(
  clientLabel: string,
  yesterdaySpend: number,
  currency: string,
  asOfLocal: string,
): string {
  return (
    `🌑 ${clientLabel} spent ${money(yesterdaySpend, currency)} yesterday but has ` +
    `no delivery recorded so far today (as of ${asOfLocal} local) — ` +
    `either paused deliberately or worth checking.`
  );
}

// ---------------------------------------------------------------------------
// Per-account assembly (pure)
// ---------------------------------------------------------------------------

export function buildAccountEvents(input: AccountPulseInput): PulseEvent[] {
  const pinged = input.alreadyPinged ?? new Set<string>();
  const events: PulseEvent[] = [];

  const base = {
    clientCode: input.clientCode,
    pilotName: input.pilotName,
    accountLabel: input.accountLabel,
    adAccountId: input.adAccountId,
    date: input.today,
  };

  // 1. New ads that started spending today — one line per creative, and only
  //    once the launch is materially delivering.
  const newAdFloor = Math.max(
    NEW_AD_MIN_SPEND_ABS,
    NEW_AD_MIN_SPEND_SHARE * input.todaySpend,
  );
  const newAdGroups = groupIdsByName(
    input.newAds.map((n) => ({ adId: n.adId, adName: n.adName, item: n })),
  )
    .map((g) => ({
      ...g,
      spend: g.items.reduce((s, n) => s + n.spend, 0),
      results: g.items.reduce((s, n) => s + n.results, 0),
    }))
    .filter((g) => g.spend >= newAdFloor)
    .sort((a, b) => b.spend - a.spend);

  const newAdIds = new Set<string>();
  for (const g of newAdGroups.slice(0, MAX_EVENTS_PER_KIND)) {
    if (pinged.has(pulseKey(g.primaryId, 'new-ad'))) continue;
    for (const id of g.adIds) newAdIds.add(id);
    events.push({
      ...base,
      kind: 'new-ad',
      entityLevel: 'ad',
      entityId: g.primaryId,
      entityName: g.name,
      line: newAdLine(
        g.name,
        input.accountLabel,
        g.spend,
        input.currency,
        g.adIds.length,
      ),
      evidence: {
        date: input.today,
        event: 'new-ad',
        spend: round2(g.spend),
        results: g.results,
        ad_ids: g.adIds,
        // Per-ad detail survives the grouping: the LINE speaks about the
        // creative, but each ad id gets its own watch and its own numbers.
        members: g.items.map((n) => ({
          ad_id: n.adId,
          spend: round2(n.spend),
          results: n.results,
        })),
        as_of: input.asOfLocal,
      },
    });
  }

  // 2. Money out, nothing back. An ad announced as new in THIS message is not
  //    also scolded in it — but once its 🚀 line is spent (deduped on the next
  //    pulse), a burning launch becomes a money-out event on its own merits.
  if (input.expectedCpa && input.expectedCpa > 0) {
    const hits = detectMoneyOut({
      ads: input.ads,
      today: input.today,
      expectedCpa: input.expectedCpa,
      excludeAdIds: newAdIds,
    });
    for (const hit of hits.slice(0, MAX_EVENTS_PER_KIND)) {
      if (pinged.has(pulseKey(hit.adId, 'money-out'))) continue;
      events.push({
        ...base,
        kind: 'money-out',
        entityLevel: 'ad',
        entityId: hit.adId,
        entityName: hit.adName,
        line: moneyOutLine(hit, input.expectedCpa, input.currency, input.asOfLocal),
        evidence: {
          date: input.today,
          event: 'money-out',
          spend_today: round2(hit.spendToday),
          purchases_today: 0,
          expected_cpa: input.expectedCpa,
          multiple: round2(hit.multiple),
          prior_purchases_3d: hit.priorPurchases,
          ad_ids: hit.adIds,
          as_of: input.asOfLocal,
        },
      });
    }
  }

  // 3. The account went dark.
  const darkEntityId = input.adAccountId ?? input.clientCode;
  if (
    detectAccountDark({
      yesterdaySpend: input.yesterdaySpend,
      todaySpend: input.todaySpend,
      todayDataPresent: input.todayDataPresent,
      hourLocal: input.hourLocal,
    }) &&
    !pinged.has(pulseKey(darkEntityId, 'account-dark'))
  ) {
    events.push({
      ...base,
      kind: 'account-dark',
      entityLevel: 'account',
      entityId: darkEntityId,
      entityName: input.accountLabel,
      line: accountDarkLine(
        input.accountLabel,
        input.yesterdaySpend,
        input.currency,
        input.asOfLocal,
      ),
      evidence: {
        date: input.today,
        event: 'account-dark',
        yesterday: input.yesterday,
        yesterday_spend: round2(input.yesterdaySpend),
        today_spend: 0,
        as_of: input.asOfLocal,
      },
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Composition — one compact message, or nothing at all
// ---------------------------------------------------------------------------

export function renderPulse(events: PulseEvent[], now: Date = new Date()): string {
  if (!events.length) return '';

  const dateLine = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'Europe/Berlin',
  }).format(now);

  // Grouped by client, in first-seen order (pilots keep their configured order).
  const groups = new Map<string, PulseEvent[]>();
  for (const e of events) {
    const header =
      e.accountLabel && e.accountLabel !== e.pilotName
        ? `${e.pilotName} — ${e.accountLabel}`
        : e.pilotName;
    if (!groups.has(header)) groups.set(header, []);
    groups.get(header)!.push(e);
  }

  const sections = [...groups.entries()].map(
    ([header, list]) => `*${header}*\n${list.map((e) => e.line).join('\n')}`,
  );

  return [
    `⚡ *Intraday pulse* — ${dateLine}`,
    ...sections,
    '_Partial-day events on each account\'s own clock. Nothing here is a verdict on the day — that comes in the morning brief._',
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Ledger reads + writes (DAI Supabase)
// ---------------------------------------------------------------------------

/** Keys already pinged for this client on this account-local day. */
async function fetchPingedToday(
  clientCode: string,
  today: string,
  now: Date,
): Promise<Set<string>> {
  const { data, error } = await getDaiSupabase()
    .from('ada_insights')
    .select('entity_id, evidence')
    .eq('client_code', clientCode)
    .eq('source', 'intraday-pulse')
    // Two account-local days can straddle three server days; a small window
    // keeps the read cheap without ever missing today's own rows.
    .gte('derived_at', new Date(now.getTime() - 3 * 86400_000).toISOString());
  if (error) {
    // Fail LOUD but fail SAFE: if we cannot read the dedupe rows we would
    // rather repeat a ping than go silent on a live event.
    logger.error({ err: error.message, clientCode }, 'intraday dedupe read failed');
    return new Set();
  }
  const keys = new Set<string>();
  for (const r of (data ?? []) as Array<{
    entity_id: string | null;
    evidence: { date?: string; event?: string } | null;
  }>) {
    if (!r.entity_id || !r.evidence) continue;
    if (r.evidence.date !== today) continue;
    if (!r.evidence.event) continue;
    keys.add(pulseKey(r.entity_id, r.evidence.event as PulseEventKind));
  }
  return keys;
}

/**
 * Ad ids that already carry a launch watch, whoever opened it. The morning
 * brief writes these too — the guard is deliberately blind to source and
 * status so the two paths can never open the same watch twice.
 */
async function fetchExistingWatchIds(
  clientCode: string,
  adIds: string[],
): Promise<Set<string>> {
  if (!adIds.length) return new Set();
  const { data, error } = await getDaiSupabase()
    .from('ada_insights')
    .select('entity_id')
    .eq('client_code', clientCode)
    .eq('kind', 'launch-watch')
    .in('entity_id', adIds);
  if (error) {
    // Cannot prove absence → do not create. A missing watch is recoverable in
    // the morning; a duplicate watch corrupts every verdict that reads it.
    logger.error({ err: error.message, clientCode }, 'launch-watch guard read failed');
    return new Set(adIds);
  }
  return new Set(
    ((data ?? []) as Array<{ entity_id: string | null }>)
      .map((r) => r.entity_id)
      .filter((v): v is string => Boolean(v)),
  );
}

/** Dedupe rows for every posted event, plus watches for the new ads. */
async function writePulseLedger(events: PulseEvent[]): Promise<number> {
  if (!events.length) return 0;

  const rows: Array<Record<string, unknown>> = events.map((e) => ({
    client_code: e.clientCode,
    ad_account_id: e.adAccountId,
    entity_level: e.entityLevel,
    entity_id: e.entityId,
    entity_name: e.entityName,
    kind: 'daily-observation',
    claim: e.line,
    evidence: e.evidence,
    recheck: {
      metric: `intraday_${e.kind}`,
      scope: { client_code: e.clientCode, entity_id: e.entityId, date: e.date },
      note: 'does tomorrow morning\'s brief confirm this, or did the day recover?',
    },
    status: 'active',
    source: 'intraday-pulse',
  }));

  // Rule 1 opens the watch NOW rather than waiting for the morning — one watch
  // per ad id (the line groups the copies, the watches do not: Loop 2 grades
  // each ad on its own delivery), and only where no watch exists yet from
  // EITHER path. The morning brief opens watches too; the guard is blind to
  // source and status so the two can never open the same watch twice.
  const newAdEvents = events.filter((e) => e.kind === 'new-ad');
  const byClient = new Map<string, PulseEvent[]>();
  for (const e of newAdEvents) {
    if (!byClient.has(e.clientCode)) byClient.set(e.clientCode, []);
    byClient.get(e.clientCode)!.push(e);
  }
  for (const [clientCode, list] of byClient) {
    const wanted = list.flatMap((e) => {
      const members = Array.isArray(e.evidence.members)
        ? (e.evidence.members as Array<{ ad_id: string; spend: number; results: number }>)
        : [
            {
              ad_id: e.entityId,
              spend: Number(e.evidence.spend) || 0,
              results: Number(e.evidence.results) || 0,
            },
          ];
      return members.map((m) => ({ member: m, event: e }));
    });
    const existing = await fetchExistingWatchIds(
      clientCode,
      wanted.map((w) => w.member.ad_id),
    );
    for (const { member, event: e } of wanted) {
      if (existing.has(member.ad_id)) {
        logger.info(
          { clientCode, adId: member.ad_id },
          'launch watch already open — not duplicating',
        );
        continue;
      }
      rows.push({
        client_code: clientCode,
        ad_account_id: e.adAccountId,
        entity_level: 'ad',
        entity_id: member.ad_id,
        entity_name: e.entityName,
        kind: 'launch-watch',
        claim: `First spend ${e.date}: "${truncate(
          e.entityName,
          60,
        )}" (${member.spend.toFixed(2)}, ${
          member.results
        } purchases, seen intraday). Verdicts due at 24h/72h/7d.`,
        evidence: {
          first_spend_date: e.date,
          source_event: 'intraday',
          spend: member.spend,
          results: member.results,
        },
        recheck: {
          metric: 'launch_watch',
          scope: { client_code: clientCode, ad_id: member.ad_id },
          checkpoints: [1, 3, 7],
        },
        status: 'active',
        source: 'loop-2-watch',
      });
    }
  }

  const { error } = await getDaiSupabase().from('ada_insights').insert(rows);
  if (error) {
    logger.error({ err: error.message }, 'intraday pulse ledger write failed');
    return 0;
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Warehouse reads
// ---------------------------------------------------------------------------

/** Yesterday + today at account level — the dark rule's evidence. */
async function fetchAccountEdge(
  clientId: string,
  yesterday: string,
  today: string,
): Promise<Array<{ date: string; spend: number }>> {
  const { data, error } = await getSupabase()
    .from('account_daily')
    .select('date, spend')
    .eq('client_id', clientId)
    .gte('date', yesterday)
    .lte('date', today);
  if (error) {
    logger.error({ err: error.message, clientId }, 'account_daily edge fetch failed');
    return [];
  }
  return (data ?? []).map((r: Record<string, unknown>) => ({
    date: String(r.date),
    spend: Number(r.spend) || 0,
  }));
}

async function pulseAccount(
  row: ClientRow,
  pilotName: string,
  now: Date,
): Promise<PulseEvent[]> {
  const tz = row.timezone ?? 'Europe/Berlin';
  const currency = row.currency ?? 'EUR';
  const today = accountToday(tz, now);
  const yesterday = accountYesterday(tz, now);
  const since = shiftDate(today, -HISTORY_DAYS);

  const ads = await fetchAdDaily(row.id, since);
  const acctEdge = await fetchAccountEdge(row.id, yesterday, today);

  const adsToday = ads.filter((a) => a.date === today);
  const acctToday = acctEdge.find((d) => d.date === today);
  const acctYesterday = acctEdge.find((d) => d.date === yesterday);

  const todaySpend = Math.max(
    adsToday.reduce((s, a) => s + a.spend, 0),
    acctToday?.spend ?? 0,
  );
  const yesterdaySpend = Math.max(
    ads.filter((a) => a.date === yesterday).reduce((s, a) => s + a.spend, 0),
    acctYesterday?.spend ?? 0,
  );
  const todayDataPresent = adsToday.length > 0 || acctToday !== undefined;

  // Rule 2's reference. No reference on file → rule 2 is skipped, never guessed.
  let expectedCpa: number | null = row.goal_bands?.happy ?? null;
  if (expectedCpa === null) {
    const config = await fetchConfigTargets(row.code);
    expectedCpa = config?.targets?.cpa ?? null;
  }

  // detectNewAds is date-parameterised — pointed at TODAY it answers
  // "first spend ever, and it happened today".
  const newAds = todaySpend > 0 ? await detectNewAds(row.id, ads, today) : [];

  const alreadyPinged = await fetchPingedToday(row.code, today, now);

  return buildAccountEvents({
    clientCode: row.code,
    pilotName,
    accountLabel: row.account_label ?? row.name,
    adAccountId: row.ad_account_id,
    currency,
    today,
    yesterday,
    asOfLocal: accountClock(tz, now),
    hourLocal: accountHour(tz, now),
    ads,
    newAds,
    expectedCpa,
    yesterdaySpend,
    todaySpend,
    todayDataPresent,
    alreadyPinged,
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runIntradayPulse(
  opts: IntradayPulseOptions = {},
): Promise<IntradayPulseResult> {
  const pilots = opts.pilots ?? PILOT_CLIENTS;
  const now = opts.now ?? new Date();
  const writeToLedger = opts.writeToLedger ?? opts.post ?? false;

  const events: PulseEvent[] = [];
  for (const code of pilots) {
    const group = await fetchClientGroup(code);
    if (!group.length) {
      logger.warn({ code }, 'intraday pulse: no active client rows');
      continue;
    }
    const top = group.find((g) => g.code === code) ?? group[0]!;
    for (const row of group) {
      try {
        events.push(...(await pulseAccount(row, top.name, now)));
      } catch (err) {
        // One broken account must not silence the others.
        logger.error(
          { err: err instanceof Error ? err.message : String(err), code: row.code },
          'intraday pulse account failed',
        );
      }
    }
  }

  const text = renderPulse(events, now);
  const channel = env.AGENCY_BRIEF_CHANNEL_ID ?? DEFAULT_CHANNEL;

  if (!events.length) {
    logger.info({ pilots }, 'Intraday pulse: nothing event-worthy — staying silent');
    return { events, text, posted: false, channel: null, insightsWritten: 0 };
  }

  // Post BEFORE writing the dedupe rows. A repeated ping is noise we can see;
  // a dedupe row for a message that never sent is an event lost in silence.
  let posted = false;
  if (opts.post) {
    await getDedicatedBotClient('ada').chat.postMessage({ channel, text });
    posted = true;
    logger.info({ channel, events: events.length }, 'Intraday pulse posted');
  }

  const insightsWritten = writeToLedger ? await writePulseLedger(events) : 0;

  return { events, text, posted, channel: opts.post ? channel : null, insightsWritten };
}
