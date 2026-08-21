import { logger } from '../utils/logger.js';
import type { AuditSection } from './magic-audit.js';
import type { PackAdRow } from './report-pack.js';
import type { LibraryAd } from './library-triage.js';
import {
  rankTopAds, extractLibraryMedia, matchLibraryMedia, pickMedia,
  buildColdCreativeFacts, fallbackWinners,
  type GraphCreativeLite, type CreativeRead, type UnresolvedAd, type ResolvedMedia, type StoreMediaCandidate,
} from './cold-creative-source.js';

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
const GEMINI_COST_LABEL = 'gemini_creative';

// gemini-3-flash-preview is the bulk tier (NEVER older models; the deep tier
// would be gemini-3.1-pro-preview — gemini-3-pro-preview is retired/404).
const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
// Conservative per-token estimates for the meter (flash-class pricing).
const GEMINI_IN_PER_M = 0.5;
const GEMINI_OUT_PER_M = 3.0;
const GEMINI_FLAT_FALLBACK_USD = 0.03;

/** Structural view of the orchestrator's CostMeter (class is module-private). */
export interface AuditCostMeter {
  spentUsd: number;
  readonly breakdown: Record<string, number>;
  add(label: string, usd: number): void;
  exhausted(): boolean;
}

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

// ---------------------------------------------------------------------------
// Bounded media download
// ---------------------------------------------------------------------------

export async function downloadMedia(
  url: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; mime: string }> {
  const resp = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`media download failed: ${resp.status}`);
  const declared = Number(resp.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(`media too large: ${declared} bytes (cap ${maxBytes})`);
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('media download had no body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`media too large: exceeded ${maxBytes} bytes mid-stream`);
    }
    chunks.push(value);
  }
  const mime = (resp.headers.get('content-type') ?? '').split(';')[0]!.trim() || 'application/octet-stream';
  return { bytes: Buffer.concat(chunks), mime };
}

// ---------------------------------------------------------------------------
// Minimal Gemini client (REST; no SDK in this repo). Files API for video,
// inline base64 for images.
// ---------------------------------------------------------------------------

function geminiKey(): string | null {
  return process.env.GEMINI_API_KEY ?? null;
}

async function geminiUploadFile(key: string, bytes: Buffer, mime: string): Promise<{ uri: string; name: string }> {
  const start = await fetch(`${GEMINI_BASE}/upload/v1beta/files?key=${key}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.byteLength),
      'X-Goog-Upload-Header-Content-Type': mime,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: 'audit-creative' } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!start.ok) throw new Error(`gemini upload start failed: ${start.status}`);
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('gemini upload start returned no upload url');
  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
    },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(120_000),
  });
  if (!up.ok) throw new Error(`gemini upload failed: ${up.status}`);
  const body = (await up.json()) as { file?: { uri?: string; name?: string; state?: string } };
  if (!body.file?.uri || !body.file.name) throw new Error('gemini upload returned no file uri');
  return { uri: body.file.uri, name: body.file.name };
}

async function geminiWaitActive(key: string, name: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const resp = await fetch(`${GEMINI_BASE}/v1beta/${name}?key=${key}`, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) throw new Error(`gemini file state read failed: ${resp.status}`);
    const body = (await resp.json()) as { state?: string };
    if (body.state === 'ACTIVE') return;
    if (body.state === 'FAILED') throw new Error('gemini file processing FAILED');
    if (Date.now() > deadline) throw new Error('gemini file processing timed out');
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function geminiDeleteFile(key: string, name: string): Promise<void> {
  try {
    await fetch(`${GEMINI_BASE}/v1beta/${name}?key=${key}`, { method: 'DELETE', signal: AbortSignal.timeout(15_000) });
  } catch {
    /* best effort — Files API auto-expires after 48h anyway */
  }
}

interface GeminiUsage { promptTokenCount?: number; candidatesTokenCount?: number }

async function geminiGenerateJson<T>(
  key: string,
  parts: unknown[],
  meter: AuditCostMeter,
): Promise<T> {
  const resp = await fetch(`${GEMINI_BASE}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { response_mime_type: 'application/json', temperature: 0.2, maxOutputTokens: 800 },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`gemini generateContent failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const body = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: GeminiUsage;
  };
  const u = body.usageMetadata;
  meter.add(
    GEMINI_COST_LABEL,
    u?.promptTokenCount != null
      ? ((u.promptTokenCount ?? 0) * GEMINI_IN_PER_M + (u.candidatesTokenCount ?? 0) * GEMINI_OUT_PER_M) / 1_000_000
      : GEMINI_FLAT_FALLBACK_USD,
  );
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in gemini output');
  return JSON.parse(text.slice(start, end + 1)) as T;
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
  /** Null on the tokenless Tinkers bridge path — no Graph read runs then. */
  accessToken: string | null;
  accountName: string;
  currency: string;
  /** 30d ad-level rows (cold pack rows filtered upstream). */
  rows30: PackAdRow[];
  /** Memoized own-Ads-Library scrape (shared with competitor_teardown). */
  getOwnLibrary: () => Promise<OwnLibraryScrape>;
  /** The orchestrator's Opus synthesizeJson, bound to meter + synth system. */
  synthesize: <T>(label: string, user: string) => Promise<T | null>;
  /** Per-ad creatives from the Tinkers media store, keyed by provider ad id.
   *  On the tokenless path both the media and the copy come from here; with a
   *  token it still wins on fidelity wherever a file exists (pickMedia). */
  storeMedia?: Map<string, StoreMediaCandidate> | null;
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

  // 1) One batched Graph read: creative text + media identifiers. Tokenless
  //    (the Tinkers bridge) skips Graph entirely — the store carries the words.
  let graphByAdId = new Map<string, GraphCreativeLite>();
  if (args.accessToken) {
    try {
      graphByAdId = await fetchGraphCreatives(args.accessToken, summary.ads.map((a) => a.ad_id));
    } catch (err) {
      logger.warn({ err }, 'cold creative: graph creative batch failed (continuing on library fallback only)');
      sectionWarnings.push('Meta creative details were not readable for this connection — analysis ran on the public Ads Library copies only.');
    }
  }
  // Store words fill in for ads Graph did not describe, so the text matching
  // and the synthesis facts see the ad copy either way.
  for (const ad of summary.ads) {
    const store = args.storeMedia?.get(ad.ad_id);
    if (!store || graphByAdId.has(ad.ad_id)) continue;
    graphByAdId.set(ad.ad_id, {
      ad_id: ad.ad_id,
      body: store.body,
      title: store.title,
      video_id: null,
      image_url: null,
      thumbnail_url: null,
    });
  }

  // 2) Video source URLs — usually denied on ads_read; stop probing after 3
  //    consecutive misses (the account-level permission answer won't change).
  const videoSourceByAdId = new Map<string, string>();
  let consecutiveMisses = 0;
  for (const ad of summary.ads) {
    const videoId = graphByAdId.get(ad.ad_id)?.video_id;
    if (!ad.is_video || !videoId || consecutiveMisses >= 3) continue;
    const src = args.accessToken ? await fetchVideoSourceUrl(args.accessToken, videoId) : null;
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
    const store = args.storeMedia?.get(ad.ad_id) ?? null;
    return !pickMedia({ videoSourceUrl: videoSourceByAdId.get(ad.ad_id) ?? null, graph: g, lib: null, store }) ||
      (ad.is_video && !videoSourceByAdId.has(ad.ad_id) && !store?.video_url);
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
    const store = args.storeMedia?.get(ad.ad_id) ?? null;
    const lib = libraryCandidates.length
      ? matchLibraryMedia({ body: graph?.body ?? null, title: graph?.title ?? null }, libraryCandidates)
      : null;
    const media = pickMedia({ videoSourceUrl: videoSourceByAdId.get(ad.ad_id) ?? null, graph, lib, store });
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
      `Write the "Creative Performance & Angles" audit section. Voice: plain operator language. Never use "not X but Y" constructions. No metaphors.\n` +
      `SCOPE: every claim about creative, copy, hooks, casting or format covers ONLY the ads in top_ads, and a claim ` +
      `about what was WATCHED covers only the creatives_watched count. Say "the ${'${'}facts.creatives_watched${'}'} creatives we watched" or ` +
      `"the top ${'${'}facts.top_ads_in_facts${'}'} ads by spend", never "every ad" or "all your creative". Quote no field names in a sentence.\n` +
      `Schema:\n` +
      `{"summary": "2-3 sentences, must name at least one specific ad and number",` +
      `"winners": [up to 4 of {"ad_name","spend","key_stat","why"}] (key_stat quotes the ad's OWN kpi field from the facts, e.g. "Meta ROAS 3.4", "Meta CPL 18.59" or "hook rate 38%" — never a metric the facts do not carry, and never a zero, why = one sharp sentence on WHY it wins, grounded in its creative_read hook/format/casting when present),` +
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
      data: { ...baseData, winners: fallbackWinners(summary, reads, 4, args.currency), angle_patterns: [], gaps: [] },
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
