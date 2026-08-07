/**
 * The why-clause — diagnosis under every mover (Loop 3, first slice).
 *
 * Deterministic implementation of Daniel's root-cause method
 * (tinkers docs/factory/day-2026-07-27/root-cause-method-nina-call.md;
 * spec: docs/factory/day-2026-08-07/why-clause-design.md):
 * pin the onset, decompose the funnel into moved-vs-flat (the flat stages
 * localize the cause), split response from cost (CPM), join the change
 * ledger, check behavior-vs-measurement, end with a so-what. Wins get the
 * same interrogation as losses. When the data doesn't support a cause, the
 * clause says "cause unclear" and lists what was checked — it never invents.
 *
 * Pure math + composition; all I/O stays in the caller (agency-morning-brief).
 */

export interface AdDayWhy {
  date: string;
  ad_id: string;
  ad_name: string | null;
  adset_id: string | null;
  campaign_id: string | null;
  spend: number;
  impressions: number;
  link_clicks: number;
  hook_rate: number | null; // stored as 3s-views / impressions
  frequency: number | null;
  content_views: number;
  purchases: number;
}

export interface ChangeEvent {
  event_time: string;
  event_type: string;
  object_type: string | null;
  object_id: string | null;
  object_name: string | null;
  actor_name: string | null;
}

export interface MixShift {
  dimension: string; // 'country' | 'platform'
  value: string;
  fromShare: number;
  toShare: number;
}

export interface WhyResult {
  causeClass:
    | 'bad_traffic'
    | 'creative_response'
    | 'post_hook'
    | 'auction_inflation'
    | 'conversion_break'
    | 'measurement_suspect'
    | 'delivery_shift'
    | 'improved'
    | 'unclear';
  text: string; // the story, numbers included
  next: string; // one advisory move
  evidence: Record<string, unknown>;
}

// ---------------------------------------------------------------------------

interface StageRead {
  yesterday: number | null;
  trailing: number | null;
  rel: number | null; // (y - t) / t
  moved: boolean;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}
function signedPct(rel: number): string {
  return `${rel > 0 ? '+' : ''}${Math.round(rel * 100)}%`;
}

/** Pooled ratio yesterday vs pooled trailing, with denominator floors. */
function readStage(
  yNum: number,
  yDen: number,
  tNum: number,
  tDen: number,
  denFloor: number,
  movedAt = 0.2,
): StageRead {
  const yesterday = yDen >= denFloor ? yNum / yDen : null;
  const trailing = tDen >= denFloor ? tNum / tDen : null;
  if (yesterday === null || trailing === null || trailing === 0) {
    return { yesterday, trailing, rel: null, moved: false };
  }
  const rel = (yesterday - trailing) / trailing;
  return { yesterday, trailing, rel, moved: Math.abs(rel) > movedAt };
}

function sum(rows: AdDayWhy[], f: (r: AdDayWhy) => number): number {
  return rows.reduce((s, r) => s + f(r), 0);
}

export interface FunnelRead {
  hook: StageRead;
  click: StageRead;
  convert: StageRead; // purchases per link click
  cpm: StageRead; // cost side (movedAt 0.2)
  impressionsRel: number | null; // delivery volume vs trailing daily avg
  frequencyY: number | null;
  hasEcomStages: boolean;
  pdp: StageRead | null; // content_views per click, when the account has them
}

export function readFunnel(adRows: AdDayWhy[], yesterday: string): FunnelRead | null {
  const y = adRows.filter((r) => r.date === yesterday);
  const t = adRows.filter((r) => r.date < yesterday && r.spend > 0).slice(-7);
  if (!y.length || t.length < 3) return null;

  const yImp = sum(y, (r) => r.impressions);
  const tImp = sum(t, (r) => r.impressions);
  const yClicks = sum(y, (r) => r.link_clicks);
  const tClicks = sum(t, (r) => r.link_clicks);

  // hook_rate is stored per-day; weight by impressions to pool it — but ONLY
  // over rows that carry the field. A null hook_rate (image ads, unpopulated
  // days) is absence of data, not a 0% hook (review fix 2026-08-08).
  const yHookRows = y.filter((r) => r.hook_rate !== null);
  const tHookRows = t.filter((r) => r.hook_rate !== null);
  const yHooks = sum(yHookRows, (r) => (r.hook_rate ?? 0) * r.impressions);
  const tHooks = sum(tHookRows, (r) => (r.hook_rate ?? 0) * r.impressions);
  const yHookImp = sum(yHookRows, (r) => r.impressions);
  const tHookImp = sum(tHookRows, (r) => r.impressions);

  const hasEcomStages = sum(t, (r) => r.content_views) > 0;

  return {
    hook: readStage(yHooks, yHookImp, tHooks, tHookImp, 1000),
    click: readStage(yClicks, yImp, tClicks, tImp, 1000),
    convert: readStage(sum(y, (r) => r.purchases), yClicks, sum(t, (r) => r.purchases), tClicks, 20, 0.25),
    cpm: readStage(sum(y, (r) => r.spend) * 1000, yImp, sum(t, (r) => r.spend) * 1000, tImp, 1000),
    impressionsRel: tImp > 0 ? (yImp - tImp / t.length) / (tImp / t.length) : null,
    frequencyY: y[0]?.frequency ?? null,
    hasEcomStages,
    pdp: hasEcomStages
      ? readStage(sum(y, (r) => r.content_views), yClicks, sum(t, (r) => r.content_views), tClicks, 20, 0.25)
      : null,
  };
}

/** First day (walking back from yesterday) the ad's daily CPA breached its
 * trailing norm — "new yesterday" vs "building since Wed, Aug 5". */
export function findOnset(
  adRows: AdDayWhy[],
  yesterday: string,
  trailingCpa: number,
): { days: number; firstDate: string } {
  const days = adRows
    .filter((r) => r.date <= yesterday && r.spend > 0)
    .sort((a, b) => b.date.localeCompare(a.date));
  let count = 0;
  let firstDate = yesterday;
  for (const d of days) {
    const breach =
      (d.purchases === 0 && d.spend > trailingCpa) ||
      (d.purchases > 0 && d.spend / d.purchases > trailingCpa * 1.25);
    if (!breach) break;
    count += 1;
    firstDate = d.date;
    if (count >= 7) break;
  }
  return { days: Math.max(count, 1), firstDate };
}

// ---------------------------------------------------------------------------

export interface WhyContext {
  moverKind: 'cpa_shift' | 'zero_results_on_spend' | 'spend_share_shift';
  direction: 'bad' | 'good';
  adRows: AdDayWhy[]; // this ad only, ascending by date
  peerRows: AdDayWhy[]; // ALL the account's ad rows in the window (incl. this ad)
  yesterday: string;
  changes: ChangeEvent[]; // already filtered to this ad / its adset / its campaign
  mixShifts: MixShift[]; // account-level, pre-computed
  dayLabel: (d: string) => string;
}

/** Account-minus-this-ad conversion move — the measurement check. */
function accountConvertShift(ctx: WhyContext): number | null {
  const others = ctx.peerRows.filter((r) => r.ad_id !== ctx.adRows[0]?.ad_id);
  const y = others.filter((r) => r.date === ctx.yesterday);
  const t = others.filter((r) => r.date < ctx.yesterday && r.spend > 0);
  const read = readStage(
    sum(y, (r) => r.purchases),
    sum(y, (r) => r.link_clicks),
    sum(t, (r) => r.purchases),
    sum(t, (r) => r.link_clicks),
    50,
  );
  return read.rel;
}

function renderChanges(ctx: WhyContext): string | null {
  if (!ctx.changes.length) return null;
  const c = ctx.changes[0]!;
  const who = c.actor_name ? `${c.actor_name} ` : '';
  const what = c.event_type.replace(/_/g, ' ');
  const on = c.object_type ? ` on its ${c.object_type}` : '';
  const extra = ctx.changes.length > 1 ? ` (+${ctx.changes.length - 1} more changes)` : '';
  return `${who}${what}${on} ${ctx.dayLabel(c.event_time.slice(0, 10))}${extra}`;
}

export function composeWhy(ctx: WhyContext): WhyResult {
  const funnel = readFunnel(ctx.adRows, ctx.yesterday);
  const changeLine = renderChanges(ctx);
  const checked =
    'hook, clicks, conversion, CPM, delivery volume and the change history all within normal range';

  if (!funnel) {
    return {
      causeClass: 'unclear',
      text: `not enough history to decompose the funnel yet`,
      next: 'on the ledger — re-checked tomorrow as data accrues',
      evidence: { reason: 'insufficient_history' },
    };
  }

  const ev: Record<string, unknown> = {
    hook: funnel.hook,
    click: funnel.click,
    convert: funnel.convert,
    cpm: funnel.cpm,
    impressions_rel: funnel.impressionsRel,
    changes: ctx.changes.length,
    mix_shifts: ctx.mixShifts,
  };
  const withChange = (s: string) => (changeLine ? `${s}; change history: ${changeLine}` : s);

  // Spend-share movers: the why is where the budget went / came from.
  if (ctx.moverKind === 'spend_share_shift') {
    const sibling = biggestOpposingShareMove(ctx);
    const perf =
      funnel.convert.rel !== null && Math.abs(funnel.convert.rel) > 0.25
        ? funnel.convert.rel < 0
          ? ` — and its click→purchase rate fell ${signedPct(funnel.convert.rel)} alongside`
          : ` — while its click→purchase rate improved ${signedPct(funnel.convert.rel)}`
        : ' — performance held while delivery moved';
    const siblingLine = sibling
      ? ` ${sibling.gained ? 'The spend came from' : 'The spend went to'} "${sibling.name}" (${pct(sibling.fromShare)} → ${pct(sibling.toShare)} of account).`
      : '';
    return {
      causeClass: 'delivery_shift',
      text: withChange(
        `Meta reallocated delivery${perf}.${siblingLine}` +
          (changeLine ? '' : ' No manual change found in the ledger — an auction move, not a human one.'),
      ),
      next:
        funnel.convert.rel !== null && funnel.convert.rel < -0.25
          ? 'watch one more day — if the rate stays down while share stays up, cap or rebalance'
          : 'no action — delivery shifts with performance intact are Meta doing its job',
      evidence: { ...ev, sibling },
    };
  }

  // Measurement before behavior: conversions collapsed here AND everywhere.
  const acctShift = accountConvertShift(ctx);
  const convCollapsed = funnel.convert.rel !== null && funnel.convert.rel < -0.5;
  if (
    (ctx.moverKind === 'zero_results_on_spend' || convCollapsed) &&
    acctShift !== null &&
    acctShift < -0.35
  ) {
    return {
      causeClass: 'measurement_suspect',
      text: withChange(
        `clicks kept flowing but conversions collapsed account-wide (rest of account ${signedPct(acctShift)}), not just on this ad — that pattern is usually tracking, not behavior`,
      ),
      next: 'check Events Manager / pixel before judging any ad on this day',
      evidence: { ...ev, account_convert_rel: acctShift },
    };
  }

  // Good movers get the same interrogation ("Nice. Why?").
  if (ctx.direction === 'good') {
    const drivers: string[] = [];
    if (funnel.hook.moved && (funnel.hook.rel ?? 0) > 0)
      drivers.push(`hook ${pct(funnel.hook.trailing!)} → ${pct(funnel.hook.yesterday!)}`);
    if (funnel.convert.moved && (funnel.convert.rel ?? 0) > 0)
      drivers.push(
        `click→purchase ${pct(funnel.convert.trailing!)} → ${pct(funnel.convert.yesterday!)}`,
      );
    if (funnel.cpm.moved && (funnel.cpm.rel ?? 0) < 0)
      drivers.push(`CPM ${signedPct(funnel.cpm.rel!)}`);
    return {
      causeClass: 'improved',
      text: withChange(
        drivers.length
          ? `the improvement is real response, not luck: ${drivers.join(', ')}`
          : `rates look flat — the improvement is thin-sample luck until it repeats`,
      ),
      next: drivers.length
        ? 'mechanism worth repeating — note what this creative/audience does differently'
        : 'no action — re-check tomorrow before celebrating',
      evidence: ev,
    };
  }

  // Bad-traffic signature (the Teeth Lovers case): conversion fell while
  // delivery got cheaper/broader — the extra traffic was bad traffic.
  const deliveryBroadened =
    (funnel.cpm.rel !== null && funnel.cpm.rel < -0.2) ||
    (funnel.impressionsRel !== null && funnel.impressionsRel > 0.3);
  if (funnel.convert.rel !== null && funnel.convert.rel < -0.25 && deliveryBroadened) {
    const bits = [
      `delivery broadened (impressions ${signedPct(funnel.impressionsRel ?? 0)}, CPM ${signedPct(funnel.cpm.rel ?? 0)})`,
      `and the extra traffic converted worse (click→purchase ${pct(funnel.convert.trailing!)} → ${pct(funnel.convert.yesterday!)})`,
    ];
    if (funnel.hook.moved && (funnel.hook.rel ?? 0) < 0)
      bits.push(`hook also dipped ${signedPct(funnel.hook.rel!)}`);
    const mix = ctx.mixShifts[0];
    if (mix)
      bits.push(
        `account-wide, ${mix.dimension} mix moved (${mix.value} ${pct(mix.fromShare)} → ${pct(mix.toShare)})`,
      );
    return {
      causeClass: 'bad_traffic',
      text: withChange(`${bits.join(', ')} — cheaper, worse traffic`),
      next: 'hold budget — don’t chase this with more spend; re-check tomorrow',
      evidence: ev,
    };
  }

  // Creative response fell.
  if (funnel.hook.moved && (funnel.hook.rel ?? 0) < 0) {
    const fatigue = (funnel.frequencyY ?? 0) > 2.5;
    return {
      causeClass: 'creative_response',
      text: withChange(
        `people stopped stopping for it — hook ${pct(funnel.hook.trailing!)} → ${pct(funnel.hook.yesterday!)}${fatigue ? `, frequency ${funnel.frequencyY!.toFixed(1)} (fatigue territory)` : ''}, later stages ${funnel.convert.moved ? 'moved with it' : 'flat'}`,
      ),
      next: fatigue
        ? 'fatigue pattern — line up a replacement creative'
        : 'creative response dip — one more day before acting',
      evidence: ev,
    };
  }

  // Post-hook interest fell.
  if (funnel.click.moved && (funnel.click.rel ?? 0) < 0 && !funnel.hook.moved) {
    return {
      causeClass: 'post_hook',
      text: withChange(
        `they stop but don’t click — hook flat, click rate ${pct(funnel.click.trailing!)} → ${pct(funnel.click.yesterday!)}`,
      ),
      next: 'mid-video / offer framing is the suspect, not the opening',
      evidence: ev,
    };
  }

  // Auction inflation: response flat, price up.
  if (
    funnel.cpm.rel !== null &&
    funnel.cpm.rel > 0.2 &&
    !funnel.hook.moved &&
    !funnel.click.moved &&
    !(funnel.convert.moved && (funnel.convert.rel ?? 0) < 0)
  ) {
    return {
      causeClass: 'auction_inflation',
      text: withChange(
        `response unchanged (hook, clicks, conversion all flat) — the auction got pricier, CPM ${signedPct(funnel.cpm.rel)}`,
      ),
      next: 'nothing to fix on the ad — hold and let the auction settle',
      evidence: ev,
    };
  }

  // Conversion-side break with clean traffic.
  if (funnel.convert.rel !== null && funnel.convert.rel < -0.25) {
    const pdpBit =
      funnel.pdp && funnel.pdp.moved
        ? `product-page views per click ${pct(funnel.pdp.trailing!)} → ${pct(funnel.pdp.yesterday!)} — the break is before the site converts`
        : `traffic quality flat (hook, clicks unchanged) but click→purchase ${pct(funnel.convert.trailing!)} → ${pct(funnel.convert.yesterday!)} — the break is after the click`;
    return {
      causeClass: 'conversion_break',
      text: withChange(pdpBit),
      next: 'check the landing path and any site/offer changes before touching the ad',
      evidence: ev,
    };
  }

  return {
    causeClass: 'unclear',
    text: `cause unclear — ${checked}${changeLine ? `; one ledger entry: ${changeLine}` : ''}`,
    next: 'on the ledger — if it repeats tomorrow it earns a deep dive',
    evidence: ev,
  };
}

/** For delivery shifts: which sibling ad moved opposite. */
function biggestOpposingShareMove(ctx: WhyContext): {
  name: string;
  fromShare: number;
  toShare: number;
  gained: boolean;
} | null {
  const thisAd = ctx.adRows[0]?.ad_id;
  const y = ctx.peerRows.filter((r) => r.date === ctx.yesterday);
  const t = ctx.peerRows.filter((r) => r.date < ctx.yesterday && r.spend > 0);
  const ySpend = sum(y, (r) => r.spend);
  const tDays = new Set(t.map((r) => r.date)).size || 1;
  const tSpendDaily = sum(t, (r) => r.spend) / tDays;
  if (ySpend <= 0 || tSpendDaily <= 0) return null;

  const thisYShare = sum(y.filter((r) => r.ad_id === thisAd), (r) => r.spend) / ySpend;
  const thisTShare = sum(t.filter((r) => r.ad_id === thisAd), (r) => r.spend) / tDays / tSpendDaily;
  const thisGained = thisYShare > thisTShare;

  let best: { name: string; fromShare: number; toShare: number; gained: boolean } | null = null;
  let bestDelta = 0.05; // minimum share move worth naming
  const byAd = new Map<string, { y: number; t: number; name: string }>();
  for (const r of ctx.peerRows) {
    if (r.ad_id === thisAd) continue;
    const cur = byAd.get(r.ad_id) ?? { y: 0, t: 0, name: r.ad_name ?? r.ad_id };
    if (r.date === ctx.yesterday) cur.y += r.spend;
    else if (r.spend > 0) cur.t += r.spend;
    byAd.set(r.ad_id, cur);
  }
  for (const [, v] of byAd) {
    const yShare = v.y / ySpend;
    const tShare = v.t / tDays / tSpendDaily;
    const delta = yShare - tShare;
    // opposite direction to this ad's move
    if (thisGained ? delta < -bestDelta : delta > bestDelta) {
      bestDelta = Math.abs(delta);
      best = { name: v.name, fromShare: tShare, toShare: yShare, gained: thisGained };
    }
  }
  return best;
}
