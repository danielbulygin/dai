/**
 * Pure helpers for the magic audit's Ads-Library triage + synthesis parsing.
 * No env/network imports — keep this module unit-testable in isolation.
 */

export interface LibraryAd {
  ad_archive_id?: string;
  start_date?: number;
  is_active?: boolean;
  collation_count?: number;
  total?: number;
  snapshot?: {
    body?: { text?: string };
    cards?: Array<{ body?: string; title?: string; cta_type?: string; link_url?: string; video_hd_url?: string; video_sd_url?: string; original_image_url?: string }>;
    videos?: unknown[];
    images?: unknown[];
    cta_type?: string;
    link_url?: string;
    page_name?: string;
  };
  page_name?: string;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

/**
 * Catalog/dynamic (Advantage+ catalog, DPA) ads store literal `{{...}}` template
 * tokens (e.g. `{{product.brand}}`) in their Ads-Library body — Meta substitutes
 * them per product at serve time. They are NOT broken copy and must never be
 * surfaced as a "hook" (2026-07-01: audits on TWO clients reported an
 * "unrendered merge tag live and spending" — a systematic false positive).
 */
export function isDynamicTemplateBody(body: string): boolean {
  return /\{\{[^{}]+\}\}/.test(body);
}

export function triageLibrary(ads: LibraryAd[]): Record<string, unknown> {
  const active = ads.filter((a) => a.is_active !== false);
  const now = Date.now() / 1000;
  const ages = active.filter((a) => a.start_date).map((a) => (now - a.start_date!) / 86400);
  const weighted = (a: LibraryAd): number => Math.max(1, num(a.collation_count));

  const cards = (a: LibraryAd) => a.snapshot?.cards ?? [];
  const isVideo = (a: LibraryAd): boolean =>
    cards(a).some((c) => c.video_hd_url || c.video_sd_url) || (a.snapshot?.videos?.length ?? 0) > 0;

  const totalW = active.reduce((s, a) => s + weighted(a), 0) || 1;
  const videoW = active.filter(isVideo).reduce((s, a) => s + weighted(a), 0);

  const ctaCount: Record<string, number> = {};
  const hookCount: Record<string, number> = {};
  const lpCount: Record<string, number> = {};
  let dynamicW = 0;
  for (const a of active) {
    const w = weighted(a);
    const cta = cards(a)[0]?.cta_type ?? a.snapshot?.cta_type;
    if (cta) ctaCount[cta] = (ctaCount[cta] ?? 0) + w;
    const body = (a.snapshot?.body?.text ?? cards(a)[0]?.body ?? '').trim();
    if (body) {
      if (isDynamicTemplateBody(body)) {
        // catalog creative — count its weight, keep template tokens out of top_hooks
        dynamicW += w;
      } else {
        const hook = body.replace(/\s+/g, ' ').slice(0, 80).toLowerCase();
        hookCount[hook] = (hookCount[hook] ?? 0) + w;
      }
    }
    const link = cards(a)[0]?.link_url ?? a.snapshot?.link_url;
    if (link) {
      try {
        const u = new URL(link);
        const key = `${u.hostname}${u.pathname}`.slice(0, 80);
        lpCount[key] = (lpCount[key] ?? 0) + w;
      } catch {
        /* malformed url */
      }
    }
  }
  const topN = (rec: Record<string, number>, n: number) =>
    Object.entries(rec).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, w]) => ({ value: k, weight: w }));

  return {
    active_ads_scraped: active.length,
    page_total_active: active.find((a) => a.total)?.total ?? active.length,
    oldest_active_days: ages.length ? Math.round(Math.max(...ages)) : null,
    median_age_days: ages.length ? Math.round(ages.sort((x, y) => x - y)[Math.floor(ages.length / 2)]!) : null,
    share_launched_last_30d_pct: ages.length ? Math.round((ages.filter((d) => d <= 30).length / ages.length) * 100) : null,
    video_weight_share_pct: Math.round((videoW / totalW) * 100),
    catalog_dynamic_weight_share_pct: Math.round((dynamicW / totalW) * 100),
    top_ctas: topN(ctaCount, 3),
    top_hooks: topN(hookCount, 6),
    top_landing_paths: topN(lpCount, 5),
  };
}

export function extractJson<T>(text: string): T {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in synthesis output');
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}
