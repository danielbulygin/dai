import { logger } from '../utils/logger.js';
import type { AuditSection } from './magic-audit.js';
import type { PackAdRow } from './report-pack.js';
import type { LibraryAd } from './library-triage.js';
import {
  rankTopAds, extractLibraryMedia, matchLibraryMedia, pickMedia,
  buildColdCreativeFacts, fallbackWinners,
  type GraphCreativeLite, type CreativeRead, type UnresolvedAd, type ResolvedMedia,
} from './cold-creative-source.js';
import {
  downloadMedia, geminiKey, geminiUploadFile, geminiWaitActive, geminiDeleteFile,
  geminiGenerateJson, GEMINI_COST_LABEL, type AuditCostMeter,
} from '../integrations/gemini.js';

// Re-exported for existing importers: the meter interface and the bounded
// download moved to integrations/gemini.ts when look_at_media needed them too.
export { downloadMedia };
export type { AuditCostMeter };

/**
 * Cold-path creative analysis — the IMPURE half (cold-creative-source.ts holds
 * the pure ranking/matching/synthesis-input logic). Downloads a stranger
 * account's top ads' actual creatives and reads them with Gemini, then hands
 * the deterministic facts to the audit's Opus synthesis (injected as a
 * callback so this module never imports the orchestrator at runtime).
 *
 * Hard bounds (this runs on the droplet, but it must stay boring):
 *  - ≤ MAX_CREATIVES creatives analyzed (top ads by 30d spend)
 *  - video downloads capped at MAX_VIDEO_BYTES, images at MAX_IMAGE_BYTES
 *  - Gemini reads only the first VIDEO_READ_SECONDS of a video
 *  - per-creative hard timeout, small concurrency, per-section Gemini $ cap
 *  - every per-creative failure is recorded and skipped — never fatal
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

const MAX_CREATIVES = 10;
const MAX_VIDEO_BYTES = 48 * 1024 * 1024;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const VIDEO_READ_SECONDS = 90;
const PER_CREATIVE_TIMEOUT_MS = 150_000;
const ANALYSIS_CONCURRENCY = 3;
/** Sub-cap for this section's Gemini spend, inside the global audit cap. */
const GEMINI_SECTION_CAP_USD = 1.0;

// ---------------------------------------------------------------------------
// Graph creative resolution (ads_read connection token)
// ---------------------------------------------------------------------------

interface RawGraphCreative {
  creative?: {
    body?: string;
    title?: string;
    image_url?: string;
    thumbnail_url?: string;
    video_id?: string;
    object_story_spec?: {
      video_data?: { video_id?: string; message?: string; title?: string; image_url?: string };
      link_data?: { message?: string; name?: string; picture?: string };
    };
    asset_feed_spec?: {
      bodies?: Array<{ text?: string }>;
      titles?: Array<{ text?: string }>;
      videos?: Array<{ video_id?: string }>;
    };
  };
}

/** One batched ?ids= GET → per-ad creative text + media identifiers. */
export async function fetchGraphCreatives(
  token: string,
  adIds: string[],
): Promise<Map<string, GraphCreativeLite>> {
  const out = new Map<string, GraphCreativeLite>();
  if (adIds.length === 0) return out;
  const ids = adIds.slice(0, 50);
  const fields =
    'creative{body,title,image_url,thumbnail_url,video_id,' +
    'object_story_spec{video_data{video_id,message,title,image_url},link_data{message,name,picture}},' +
    'asset_feed_spec{bodies,titles,videos{video_id}}}';
  const resp = await fetch(
    `${GRAPH}/?ids=${ids.join(',')}&fields=${fields}&access_token=${token}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!resp.ok) throw new Error(`creative batch read failed: ${resp.status}`);
  const body = (await resp.json()) as Record<string, RawGraphCreative>;
  for (const adId of ids) {
    const c = body[adId]?.creative;
    if (!c) continue;
    const oss = c.object_story_spec;
    const afs = c.asset_feed_spec;
    out.set(adId, {
      ad_id: adId,
      body: c.body ?? oss?.video_data?.message ?? oss?.link_data?.message ?? afs?.bodies?.[0]?.text ?? null,
      title: c.title ?? oss?.video_data?.title ?? oss?.link_data?.name ?? afs?.titles?.[0]?.text ?? null,
      video_id: c.video_id ?? oss?.video_data?.video_id ?? afs?.videos?.[0]?.video_id ?? null,
      image_url: c.image_url ?? oss?.video_data?.image_url ?? oss?.link_data?.picture ?? null,
      thumbnail_url: c.thumbnail_url ?? null,
    });
  }
  return out;
}

/**
 * Try the video's downloadable `source` URL. With ads_read alone this is
 * usually DENIED (page-scoped asset) — null is the expected common case.
 */
export async function fetchVideoSourceUrl(token: string, videoId: string): Promise<string | null> {
  try {
    const resp = await fetch(`${GRAPH}/${videoId}?fields=source&access_token=${token}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { source?: string };
    return body.source && /^https?:\/\//.test(body.source) ? body.source : null;
  } catch {
    return null;
  }
}

const CREATIVE_READ_PROMPT =
  'You are analyzing one Meta ad creative for a paid account audit. Look at it carefully and answer in plain, concrete language — describe only what is actually there. Return pure JSON:\n' +
  '{"hook":"what happens in the first 3 seconds — the spoken line, on-screen text, or opening visual (for a static image: the first thing the eye lands on)",' +
  '"angle":"the core message or promise, one sentence",' +
  '"format":"the production format, e.g. UGC selfie talking head, studio product demo, meme static, text-on-screen b-roll",' +
  '"casting":"who is on screen and the setting/style, e.g. woman around 30 in a kitchen; write none if product-only"}';

interface GeminiCreativeRead { hook?: string; angle?: string; format?: string; casting?: string }

/** One Gemini pass over one downloaded creative. */
async function analyzeCreativeMedia(
  key: string,
  media: { bytes: Buffer; mime: string; kind: 'video' | 'image' },
  meter: AuditCostMeter,
): Promise<GeminiCreativeRead> {
  if (media.kind === 'image') {
    return geminiGenerateJson<GeminiCreativeRead>(key, [
      { inline_data: { mime_type: media.mime, data: media.bytes.toString('base64') } },
      { text: CREATIVE_READ_PROMPT },
    ], meter);
  }
  const file = await geminiUploadFile(key, media.bytes, media.mime.startsWith('video/') ? media.mime : 'video/mp4');
  try {
    await geminiWaitActive(key, file.name);
    return await geminiGenerateJson<GeminiCreativeRead>(key, [
      {
        file_data: { file_uri: file.uri, mime_type: media.mime.startsWith('video/') ? media.mime : 'video/mp4' },
        video_metadata: { end_offset: `${VIDEO_READ_SECONDS}s` },
      },
      { text: CREATIVE_READ_PROMPT },
    ], meter);
  } finally {
    void geminiDeleteFile(key, file.name);
  }
}

// ---------------------------------------------------------------------------
// Section runner
// ---------------------------------------------------------------------------

export interface OwnLibraryScrape {
  page: { name: string; pageId: string };
  ads: LibraryAd[];
}

interface CreativeSynthesis {
  summary: string;
  winners: Array<{ ad_name: string; spend: number; key_stat: string; why: string }>;
  angle_patterns: Array<{ pattern: string; evidence: string }>;
  gaps: string[];
  warnings: string[];
}

/** The LLM occasionally returns numbered-keyed objects instead of plain
 *  strings in list fields ([{"1": "text"}] — live incident on the first NBN
 *  re-run, 2026-07-04: the render crashed on the object child). Coerce every
 *  list item to its string content; drop anything with none. */
export function coerceStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      if (item.trim()) out.push(item);
    } else if (typeof item === 'number' || typeof item === 'boolean') {
      out.push(String(item));
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const vals = Object.values(item as Record<string, unknown>).filter(
        (x): x is string => typeof x === 'string' && x.trim().length > 0,
      );
      if (vals.length > 0) out.push(vals.join(' '));
    }
  }
  return out;
}

export interface ColdCreativeArgs {
  meter: AuditCostMeter;
  accessToken: string;
  accountName: string;
  currency: string;
  /** 30d ad-level rows (cold pack rows filtered upstream). */
  rows30: PackAdRow[];
  /** Memoized own-Ads-Library scrape (shared with competitor_teardown). */
  getOwnLibrary: () => Promise<OwnLibraryScrape>;
  /** The orchestrator's Opus synthesizeJson, bound to meter + synth system. */
  synthesize: <T>(label: string, user: string) => Promise<T | null>;
}

const withTimeout = async <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The cold-path "Creative Performance & Angles" section: rank top ads by 30d
 * spend, resolve each ad's actual media (Graph → own Ads Library fallback),
 * read each creative with Gemini, then run ONE Opus synthesis over the
 * deterministic facts. Fail-soft everywhere below the section level.
 */
export async function runColdCreativeAnalysis(args: ColdCreativeArgs): Promise<Partial<AuditSection>> {
  const summary = rankTopAds(args.rows30, MAX_CREATIVES);
  if (summary.ads.length === 0) {
    return { status: 'error', error: 'no ads with spend in the last 30 days' };
  }
  const sectionWarnings: string[] = [];

  // 1) One batched Graph read: creative text + media identifiers.
  let graphByAdId = new Map<string, GraphCreativeLite>();
  try {
    graphByAdId = await fetchGraphCreatives(args.accessToken, summary.ads.map((a) => a.ad_id));
  } catch (err) {
    logger.warn({ err }, 'cold creative: graph creative batch failed (continuing on library fallback only)');
    sectionWarnings.push('Meta creative details were not readable for this connection — analysis ran on the public Ads Library copies only.');
  }

  // 2) Video source URLs — usually denied on ads_read; stop probing after 3
  //    consecutive misses (the account-level permission answer won't change).
  const videoSourceByAdId = new Map<string, string>();
  let consecutiveMisses = 0;
  for (const ad of summary.ads) {
    const videoId = graphByAdId.get(ad.ad_id)?.video_id;
    if (!ad.is_video || !videoId || consecutiveMisses >= 3) continue;
    const src = await fetchVideoSourceUrl(args.accessToken, videoId);
    if (src) {
      videoSourceByAdId.set(ad.ad_id, src);
      consecutiveMisses = 0;
    } else {
      consecutiveMisses += 1;
    }
  }

  // 3) Library fallback — only when at least one ad still lacks a video/image.
  const needsLibrary = summary.ads.some((ad) => {
    const g = graphByAdId.get(ad.ad_id) ?? null;
    return !pickMedia({ videoSourceUrl: videoSourceByAdId.get(ad.ad_id) ?? null, graph: g, lib: null }) ||
      (ad.is_video && !videoSourceByAdId.has(ad.ad_id));
  });
  let libraryCandidates: ReturnType<typeof extractLibraryMedia> = [];
  if (needsLibrary) {
    try {
      const lib = await args.getOwnLibrary();
      libraryCandidates = extractLibraryMedia(lib.ads);
    } catch (err) {
      logger.warn({ err }, 'cold creative: own-library scrape unavailable (falling back to Graph stills)');
    }
  }

  // 4) Resolve + download + Gemini-read each creative (bounded worker pool).
  const key = geminiKey();
  if (!key) {
    sectionWarnings.push('Visual creative analysis unavailable (no Gemini key) — this read uses delivery stats and ad copy only.');
  }
  const reads: CreativeRead[] = [];
  const unresolved: UnresolvedAd[] = [];
  const geminiSpent = (): number => args.meter.breakdown[GEMINI_COST_LABEL] ?? 0;

  const processAd = async (ad: (typeof summary.ads)[number]): Promise<void> => {
    const graph = graphByAdId.get(ad.ad_id) ?? null;
    const lib = libraryCandidates.length
      ? matchLibraryMedia({ body: graph?.body ?? null, title: graph?.title ?? null }, libraryCandidates)
      : null;
    const media = pickMedia({ videoSourceUrl: videoSourceByAdId.get(ad.ad_id) ?? null, graph, lib });
    if (!media) {
      unresolved.push({ ad_name: ad.ad_name, spend: ad.spend, reason: 'no retrievable media (Graph denied video source; no Ads Library match)' });
      return;
    }
    if (!key) {
      unresolved.push({ ad_name: ad.ad_name, spend: ad.spend, reason: 'gemini unavailable' });
      return;
    }
    if (args.meter.exhausted() || geminiSpent() >= GEMINI_SECTION_CAP_USD) {
      unresolved.push({ ad_name: ad.ad_name, spend: ad.spend, reason: 'cost cap reached before analysis' });
      return;
    }
    try {
      const read = await withTimeout(
        (async (): Promise<GeminiCreativeRead & { resolved: ResolvedMedia }> => {
          const dl = await downloadMedia(media.url, media.kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES);
          const kind: 'video' | 'image' = media.kind === 'video' && !dl.mime.startsWith('video/') && !dl.mime.includes('octet-stream')
            ? 'image' // some CDN video URLs resolve to a poster frame
            : media.kind;
          const g = await analyzeCreativeMedia(key, { bytes: dl.bytes, mime: dl.mime, kind }, args.meter);
          return { ...g, resolved: { ...media, kind } };
        })(),
        PER_CREATIVE_TIMEOUT_MS,
        `creative ${ad.ad_name}`,
      );
      reads.push({
        ad_id: ad.ad_id,
        ad_name: ad.ad_name,
        hook: (read.hook ?? '').slice(0, 300),
        angle: (read.angle ?? '').slice(0, 300),
        format: (read.format ?? '').slice(0, 120),
        casting: (read.casting ?? '').slice(0, 200),
        media_source: read.resolved.source,
        kind: read.resolved.kind,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg, ad: ad.ad_name }, 'cold creative: per-creative analysis failed (skipping ad)');
      unresolved.push({ ad_name: ad.ad_name, spend: ad.spend, reason: msg.slice(0, 160) });
    }
  };

  // Small worker pool — bounded concurrency without a dependency.
  const queue = [...summary.ads];
  await Promise.all(
    Array.from({ length: Math.min(ANALYSIS_CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const ad = queue.shift();
        if (!ad) return;
        await processAd(ad);
      }
    }),
  );

  const stillFrameReads = reads.filter((r) => summary.ads.find((a) => a.ad_id === r.ad_id)?.is_video && r.kind === 'image').length;
  if (stillFrameReads > 0) {
    sectionWarnings.push(`${stillFrameReads} video ad(s) could only be read from a still frame — Meta does not expose their video files to this connection and no public Ads Library copy matched.`);
  }

  // 5) One Opus synthesis over the deterministic facts.
  const facts = buildColdCreativeFacts({
    accountName: args.accountName,
    currency: args.currency,
    summary,
    graphByAdId,
    reads,
    unresolved,
  });
  const synth = await args.synthesize<CreativeSynthesis>(
    'creative_analysis',
    `Top-ad creative data for a freshly connected account (deterministic stats from the live Meta pull; ` +
      `creative_read fields are frame-accurate reads of the ACTUAL downloaded creatives — hooks are what literally happens in the first 3 seconds):\n` +
      `${JSON.stringify(facts, null, 1)}\n\n` +
      `Write the "Creative Performance & Angles" audit section. Voice: plain operator language. Never use "not X but Y" constructions. No metaphors. Schema:\n` +
      `{"summary": "2-3 sentences, must name at least one specific ad and number",` +
      `"winners": [up to 4 of {"ad_name","spend","key_stat","why"}] (key_stat like "Meta ROAS 3.4" or "hook rate 38%", why = one sharp sentence on WHY it wins, grounded in its creative_read hook/format/casting when present),` +
      `"angle_patterns": [up to 4 of {"pattern","evidence"}] (messaging/format/casting patterns across the spend-weighted inventory — cite the ads),` +
      `"gaps": [up to 3 strings] (creative lanes the account is NOT running that the observed inventory suggests it should test),` +
      `"warnings": [up to 3 strings] (concentration on one creative, one format, weak hooks — only if the data shows it)}`,
  );

  const baseData = {
    total_spend_30d: Math.round(summary.total_spend),
    ads_with_spend: summary.ads_with_spend,
    top12_spend_share_pct: summary.top12_spend_share_pct,
    video_spend_share_pct: summary.video_spend_share_pct,
    currency: args.currency,
    creatives_analyzed: reads.length,
    media_resolution: [
      ...reads.map((r) => ({ ad_name: r.ad_name, source: r.media_source, kind: r.kind })),
      ...unresolved.map((u) => ({ ad_name: u.ad_name, source: 'unresolved' as const, reason: u.reason })),
    ],
  };

  if (!synth) {
    return {
      status: 'complete',
      summary:
        `${summary.ads_with_spend} ads spent in the last 30 days; top 12 carry ${summary.top12_spend_share_pct}% of spend. ` +
        `Watched ${reads.length} of the top ${summary.ads.length} creatives (cost cap reached before narrative synthesis).`,
      data: { ...baseData, winners: fallbackWinners(summary, reads), angle_patterns: [], gaps: [] },
      warnings: sectionWarnings,
    };
  }

  return {
    status: 'complete',
    summary: synth.summary,
    data: {
      ...baseData,
      winners: synth.winners,
      angle_patterns: synth.angle_patterns,
      gaps: coerceStringList(synth.gaps),
    },
    warnings: [...coerceStringList(synth.warnings), ...sectionWarnings],
  };
}
