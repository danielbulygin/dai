import type { PackAdRow } from './report-pack.js';
import type { LibraryAd } from './library-triage.js';

/**
 * Cold-path creative analysis — the PURE half (cold-creative.ts is the impure
 * fetch/Gemini orchestrator, mirroring the cold-source.ts / cold-fetch.ts
 * split). Everything here is deterministic over in-memory inputs so the
 * media-resolution fallback logic and the winners synthesis are unit-testable
 * without any network.
 *
 * Media-resolution strategy (design ruling, cold path 2026-07-04):
 *  1. Graph video `source` URL — often NOT retrievable with ads_read alone.
 *  2. The brand's OWN public Ads Library scrape — match the ad's creative body
 *     / title text to a library entry and use its playable video_sd/hd URL.
 *  3. Graph full-size image_url (statics; also a still for unmatched videos).
 *  4. Library image (original_image_url).
 *  5. Graph creative thumbnail_url (low-res last resort).
 * One bad ad never kills the section — unresolved ads are reported as such.
 */

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const round2 = (v: number): number => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Top-ad ranking (30d spend) — same aggregation semantics as the warehouse
// runCreativeAnalysis, over the cold-path PackAdRow shape.
// ---------------------------------------------------------------------------

export interface TopAd {
  ad_id: string;
  ad_name: string;
  spend: number;
  roas: number;
  purchases: number;
  leads: number;
  /** Spend-weighted hook rate as a FRACTION (as ad_daily stores it), or null. */
  hook_rate: number | null;
  is_video: boolean;
}

export interface TopAdsSummary {
  /** Top `cap` ads by 30d spend — the creatives the analysis reads. */
  ads: TopAd[];
  ads_with_spend: number;
  total_spend: number;
  /** Share of 30d spend in the top 12 ads (the page chip's definition). */
  top12_spend_share_pct: number;
  video_spend_share_pct: number;
}

export function rankTopAds(rows30: PackAdRow[], cap = 10): TopAdsSummary {
  interface Agg {
    ad_name: string; spend: number; purchases: number; purchase_value: number;
    leads: number; hook_w: number; hook_imp: number; is_video: boolean;
  }
  const byAd = new Map<string, Agg>();
  for (const r of rows30) {
    const a = byAd.get(r.ad_id) ?? {
      ad_name: r.ad_name ?? r.ad_id, spend: 0, purchases: 0, purchase_value: 0,
      leads: 0, hook_w: 0, hook_imp: 0, is_video: false,
    };
    a.spend += num(r.spend);
    a.purchases += num(r.purchases);
    a.purchase_value += num(r.purchase_value);
    a.leads += num(r.leads);
    if (r.ad_name) a.ad_name = r.ad_name;
    if (num(r.hook_rate) > 0) {
      a.hook_w += num(r.hook_rate) * num(r.impressions);
      a.hook_imp += num(r.impressions);
    }
    // Cold rows carry no video_plays column — a populated hook/hold rate is
    // the video signal (both derive from video_view actions in cold-source).
    if (num(r.hook_rate) > 0 || num(r.hold_rate) > 0) a.is_video = true;
    byAd.set(r.ad_id, a);
  }

  const all = [...byAd.entries()]
    .map(([ad_id, a]) => ({
      ad_id,
      ad_name: a.ad_name,
      spend: round2(a.spend),
      roas: a.spend > 0 ? round2(a.purchase_value / a.spend) : 0,
      purchases: a.purchases,
      leads: a.leads,
      hook_rate: a.hook_imp > 0 ? round2((a.hook_w / a.hook_imp) * 10_000) / 10_000 : null,
      is_video: a.is_video,
    }))
    .filter((a) => a.spend > 0)
    .sort((a, b) => b.spend - a.spend);

  const total = all.reduce((s, a) => s + a.spend, 0);
  const videoSpend = all.filter((a) => a.is_video).reduce((s, a) => s + a.spend, 0);
  const top12Spend = all.slice(0, 12).reduce((s, a) => s + a.spend, 0);

  return {
    ads: all.slice(0, cap),
    ads_with_spend: all.length,
    total_spend: round2(total),
    top12_spend_share_pct: total > 0 ? Math.round((top12Spend / total) * 100) : 0,
    video_spend_share_pct: total > 0 ? Math.round((videoSpend / total) * 100) : 0,
  };
}

// ---------------------------------------------------------------------------
// Graph creative shape (mapped by cold-creative.ts from one batched ?ids= GET)
// ---------------------------------------------------------------------------

export interface GraphCreativeLite {
  ad_id: string;
  body: string | null;
  title: string | null;
  video_id: string | null;
  image_url: string | null;
  thumbnail_url: string | null;
}

// ---------------------------------------------------------------------------
// Ads-Library media extraction + text matching (the fallback source)
// ---------------------------------------------------------------------------

export interface LibraryMediaCandidate {
  /** Normalized (lowercased, whitespace-collapsed) creative body text. */
  body: string;
  title: string | null;
  video_url: string | null;
  image_url: string | null;
}

const normText = (s: string | null | undefined): string =>
  (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Loosely-typed snapshot media arrays (LibraryAd types them as unknown[]). */
interface SnapshotVideo { video_sd_url?: string; video_hd_url?: string; video_preview_image_url?: string }
interface SnapshotImage { original_image_url?: string; resized_image_url?: string }

export function extractLibraryMedia(ads: LibraryAd[]): LibraryMediaCandidate[] {
  const out: LibraryMediaCandidate[] = [];
  for (const a of ads) {
    const snap = a.snapshot;
    if (!snap) continue;
    const cards = snap.cards ?? [];
    const videos = (snap.videos ?? []) as SnapshotVideo[];
    const images = (snap.images ?? []) as SnapshotImage[];
    const video_url =
      videos.find((v) => v.video_sd_url || v.video_hd_url)?.video_sd_url ??
      videos.find((v) => v.video_hd_url)?.video_hd_url ??
      cards.find((c) => c.video_sd_url || c.video_hd_url)?.video_sd_url ??
      cards.find((c) => c.video_hd_url)?.video_hd_url ??
      null;
    const image_url =
      images.find((i) => i.original_image_url || i.resized_image_url)?.original_image_url ??
      images.find((i) => i.resized_image_url)?.resized_image_url ??
      cards.find((c) => c.original_image_url)?.original_image_url ??
      null;
    const body = normText(snap.body?.text ?? cards[0]?.body);
    const title = normText(cards[0]?.title) || null;
    if (!video_url && !image_url) continue;
    out.push({ body, title, video_url, image_url });
  }
  return out;
}

/** Body prefixes shorter than this are too generic to match on safely. */
const MIN_BODY_MATCH_CHARS = 20;
const MIN_TITLE_MATCH_CHARS = 8;
const BODY_PREFIX_CHARS = 120;

/**
 * Match a Graph creative to a library entry by text. Body-prefix containment
 * first (dynamic creatives truncate/extend copy between surfaces), exact title
 * second. Among equal text matches, a candidate WITH a playable video wins.
 */
export function matchLibraryMedia(
  creative: { body: string | null; title: string | null },
  candidates: LibraryMediaCandidate[],
): LibraryMediaCandidate | null {
  const body = normText(creative.body).slice(0, BODY_PREFIX_CHARS);
  const title = normText(creative.title);

  const matches: LibraryMediaCandidate[] = [];
  if (body.length >= MIN_BODY_MATCH_CHARS) {
    for (const c of candidates) {
      if (!c.body) continue;
      const cBody = c.body.slice(0, BODY_PREFIX_CHARS);
      if (cBody.startsWith(body) || body.startsWith(cBody)) matches.push(c);
    }
  }
  if (matches.length === 0 && title.length >= MIN_TITLE_MATCH_CHARS) {
    for (const c of candidates) {
      if (c.title && c.title === title) matches.push(c);
    }
  }
  if (matches.length === 0) return null;
  return matches.find((m) => m.video_url) ?? matches[0]!;
}

// ---------------------------------------------------------------------------
// Media pick order — the resolution ladder, pure so tests pin it
// ---------------------------------------------------------------------------

export type MediaSource =
  | 'store_video'
  | 'store_image'
  | 'graph_video_source'
  | 'library_video'
  | 'graph_image'
  | 'library_image'
  | 'graph_thumbnail';

/** One ad's creative as the TINKERS media store holds it (their connect burst
 *  downloads the real files at Meta connect; we get 30-minute signed URLs plus
 *  the ad's own words). On the tokenless bridge path this is the primary
 *  source — Meta serves an ads_read app only a 64×64 thumbnail, while the
 *  store has the full image or the playable mp4. */
export interface StoreMediaCandidate {
  body: string | null;
  title: string | null;
  video_url: string | null;
  image_url: string | null;
  /** A video's poster frame — the still we read when the mp4 is absent. */
  poster_url: string | null;
}

export interface ResolvedMedia {
  kind: 'video' | 'image';
  url: string;
  source: MediaSource;
}

export function pickMedia(input: {
  videoSourceUrl: string | null;
  graph: GraphCreativeLite | null;
  lib: LibraryMediaCandidate | null;
  store?: StoreMediaCandidate | null;
}): ResolvedMedia | null {
  if (input.store?.video_url) return { kind: 'video', url: input.store.video_url, source: 'store_video' };
  if (input.videoSourceUrl) return { kind: 'video', url: input.videoSourceUrl, source: 'graph_video_source' };
  if (input.lib?.video_url) return { kind: 'video', url: input.lib.video_url, source: 'library_video' };
  if (input.store?.image_url) return { kind: 'image', url: input.store.image_url, source: 'store_image' };
  if (input.graph?.image_url) return { kind: 'image', url: input.graph.image_url, source: 'graph_image' };
  if (input.lib?.image_url) return { kind: 'image', url: input.lib.image_url, source: 'library_image' };
  // A stored poster frame is a full-size still of the video — better than the
  // 64px Graph thumbnail below, worse than any playable copy above.
  if (input.store?.poster_url) return { kind: 'image', url: input.store.poster_url, source: 'store_image' };
  if (input.graph?.thumbnail_url) return { kind: 'image', url: input.graph.thumbnail_url, source: 'graph_thumbnail' };
  return null;
}

// ---------------------------------------------------------------------------
// Per-creative read + synthesis inputs/fallback
// ---------------------------------------------------------------------------

/** What one Gemini pass over one creative yields. */
export interface CreativeRead {
  ad_id: string;
  ad_name: string;
  hook: string;
  angle: string;
  format: string;
  casting: string;
  media_source: MediaSource;
  kind: 'video' | 'image';
}

export interface UnresolvedAd {
  ad_name: string;
  spend: number;
  reason: string;
}

/**
 * One ad's own cost-per-result decay, from the fatigue chapter's rows. The
 * creative read used to call an ad "cheap" on its run average while its last
 * fortnight ran 40% dearer, because the two chapters never met.
 */
export interface FatigueDecayRow {
  ad_id: string;
  ad_name: string;
  cpl_first_half: number | null;
  cpl_last_14: number | null;
}

export interface AdDecay {
  cpl_first_half: number | null;
  cpl_last_14: number | null;
  /** Percent worse the last fortnight is than the first half. Null when unknown. */
  decay_pct: number | null;
}

/**
 * Decay by ad NAME, because that is the only handle a synthesized winner gives
 * us. A name two different ads share is dropped rather than guessed at: the
 * concentration chapter already found this account running two ads under one
 * name, and attributing one ad's decay to the other would be a fabricated fact.
 */
export function decayIndex(rows: FatigueDecayRow[]): Map<string, AdDecay> {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.ad_name, (counts.get(r.ad_name) ?? 0) + 1);
  const out = new Map<string, AdDecay>();
  for (const r of rows) {
    if ((counts.get(r.ad_name) ?? 0) > 1) continue;
    const decay =
      r.cpl_first_half != null && r.cpl_first_half > 0 && r.cpl_last_14 != null
        ? Math.round(((r.cpl_last_14 - r.cpl_first_half) / r.cpl_first_half) * 1000) / 10
        : null;
    out.set(r.ad_name, { cpl_first_half: r.cpl_first_half, cpl_last_14: r.cpl_last_14, decay_pct: decay });
  }
  return out;
}

/**
 * A winner whose own last fortnight got materially dearer says so, in its why.
 * Deterministic on purpose: the facts carry the figures and the prompt asks for
 * them, but a winner tile is the most-read line in the report and it may not
 * depend on the model having obeyed.
 */
export function annotateWinnerDecay<T extends { ad_name?: unknown; why?: unknown }>(
  winners: T[],
  index: Map<string, AdDecay>,
  currency: string,
  thresholdPct = 25,
): T[] {
  const unit = currency ? ` ${currency}` : '';
  return winners.map((w) => {
    const name = typeof w.ad_name === 'string' ? w.ad_name : '';
    const d = index.get(name);
    if (!d || d.decay_pct == null || d.decay_pct < thresholdPct || d.cpl_last_14 == null || d.cpl_first_half == null) return w;
    const why = typeof w.why === 'string' ? w.why : '';
    const alreadySaid = why.includes(String(round2(d.cpl_last_14)));
    if (alreadySaid) return w;
    return {
      ...w,
      why: `${why}${why && !/[.!?]$/.test(why.trim()) ? '.' : ''} It averaged ${round2(d.cpl_first_half)}${unit} per lead over the first half of its run and its last fortnight runs ${round2(d.cpl_last_14)}${unit}.`.trim(),
    };
  });
}

/**
 * The deterministic facts payload the Opus synthesis reads.
 *
 * The account's own economics decide which number each ad carries. Sending
 * `roas: 0` on a lead-gen account collided with the synthesis rule that every
 * metric must state its source, so the section wrote apologies about ROAS 0 on
 * an account that has never sold anything online. On a lead-gen account each ad
 * carries its cost per lead instead, and the roas field is absent, not zero.
 */
export function buildColdCreativeFacts(args: {
  accountName: string;
  currency: string;
  summary: TopAdsSummary;
  graphByAdId: Map<string, GraphCreativeLite>;
  reads: CreativeRead[];
  unresolved: UnresolvedAd[];
  /** The fatigue chapter's rows, so a "cheap" winner cannot hide its decay. */
  fatigueRows?: FatigueDecayRow[];
}): Record<string, unknown> {
  const readByAd = new Map(args.reads.map((r) => [r.ad_id, r]));
  const decayByName = decayIndex(args.fatigueRows ?? []);
  const leadGen =
    args.summary.ads.every((a) => a.roas === 0 && a.purchases === 0) &&
    args.summary.ads.some((a) => a.leads > 0);
  return {
    account: args.accountName,
    currency: args.currency,
    window: 'last 30 days',
    kpi: leadGen ? 'cost per lead (this account records leads, not purchases)' : 'Meta ROAS',
    // How many creatives were actually WATCHED, so a claim about the creative
    // can be scoped to them instead of to "every ad" (live report error).
    creatives_watched: args.reads.length,
    top_ads_in_facts: args.summary.ads.length,
    total_spend: Math.round(args.summary.total_spend),
    ads_with_spend: args.summary.ads_with_spend,
    top12_spend_share_pct: args.summary.top12_spend_share_pct,
    video_spend_share_pct: args.summary.video_spend_share_pct,
    top_ads: args.summary.ads.map((a) => {
      const g = args.graphByAdId.get(a.ad_id);
      const read = readByAd.get(a.ad_id);
      return {
        ad_name: a.ad_name,
        spend: a.spend,
        ...(leadGen
          ? { cpl: a.leads > 0 ? round2(a.spend / a.leads) : null }
          : { roas: a.roas, purchases: a.purchases }),
        leads: a.leads,
        hook_rate_pct: a.hook_rate != null ? round2(a.hook_rate * 100) : null,
        is_video: a.is_video,
        // The ad's HEADLINE FIELD and its PRIMARY TEXT FIELD, named as fields:
        // the live report called a headline "identical across all ten ads" in one
        // sentence and quoted a different, on-image headline in the next.
        headline_field: g?.title ? g.title.slice(0, 120) : undefined,
        primary_text_field: g?.body ? g.body.slice(0, 220) : undefined,
        cost_per_lead_first_half: decayByName.get(a.ad_name)?.cpl_first_half ?? undefined,
        cost_per_lead_last_14: decayByName.get(a.ad_name)?.cpl_last_14 ?? undefined,
        cost_per_lead_decay_pct: decayByName.get(a.ad_name)?.decay_pct ?? undefined,
        creative_read: read
          ? {
              watched: read.kind,
              media_source: read.media_source,
              hook_first_3s: read.hook,
              angle: read.angle,
              format: read.format,
              casting: read.casting,
            }
          : undefined,
      };
    }),
    unresolved_media: args.unresolved.map((u) => ({ ad_name: u.ad_name, spend: u.spend, reason: u.reason })),
  };
}

/**
 * Deterministic winners when the LLM synthesis is unavailable (cost cap) —
 * top spenders with the sharpest stat we have, why-line from the Gemini read
 * when one exists. Plain language, no styling.
 */
export function fallbackWinners(
  summary: TopAdsSummary,
  reads: CreativeRead[],
  max = 4,
  currency = '',
): Array<{ ad_name: string; spend: number; key_stat: string; why: string }> {
  const readByAd = new Map(reads.map((r) => [r.ad_id, r]));
  const unit = currency ? ` ${currency}` : '';
  return summary.ads.slice(0, max).map((a) => {
    const read = readByAd.get(a.ad_id);
    let key_stat: string;
    // A lead-gen ad's own number is what it pays for a lead, in money. A ROAS
    // multiple on an account with no revenue is a fabricated metric, and a bare
    // lead count says nothing about whether the lead was cheap.
    if (a.roas > 0) key_stat = `Meta ROAS ${a.roas}`;
    else if (a.purchases > 0) key_stat = `${a.purchases} purchases`;
    else if (a.leads > 0 && a.spend > 0) key_stat = `Meta CPL ${round2(a.spend / a.leads)}${unit}`;
    else if (a.leads > 0) key_stat = `${a.leads} leads`;
    else if (a.hook_rate != null) key_stat = `hook rate ${round2(a.hook_rate * 100)}%`;
    else key_stat = 'top spender';
    const why = read
      ? `${read.format}. Hook: ${read.hook}`.slice(0, 220)
      : 'Top spender over the last 30 days (creative not readable for this ad).';
    return { ad_name: a.ad_name, spend: a.spend, key_stat, why };
  });
}
