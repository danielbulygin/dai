/**
 * Meta Migration — Phase 1: Audit
 *
 * Reads campaigns/adsets/ads with spend > 0 in last 90d on the OLD account,
 * extracts every asset reference (pixel, page, IG actor, audience, catalog,
 * image, video, post, custom conversion), and checks accessibility from the
 * NEW account. Writes a manifest JSON used by later phases.
 *
 * Read-only. Safe to run repeatedly.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/meta-migrate/audit.ts
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.META_ADS_ACCESS_TOKEN;
const OLD_ACCOUNT = "act_1814118775391116";
const NEW_ACCOUNT = "act_978593421213192";
const DATE_PRESET = "last_90d";
const OUTPUT = join(process.cwd(), "scripts/meta-migrate/manifest.json");

if (!TOKEN) {
  console.error("META_ADS_ACCESS_TOKEN missing");
  process.exit(1);
}

type Insights = {
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  spend: string;
};

type Json = Record<string, unknown>;

async function fbGet(path: string, params: Record<string, string> = {}): Promise<Json> {
  const url = new URL(`${API}/${path}`);
  url.searchParams.set("access_token", TOKEN!);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString());
  const body = (await r.json()) as Json;
  if (!r.ok) {
    const err = body.error as Json | undefined;
    throw new Error(`FB ${path}: ${err?.message ?? JSON.stringify(body)}`);
  }
  return body;
}

async function fbGetAll(path: string, params: Record<string, string> = {}): Promise<Json[]> {
  const all: Json[] = [];
  let nextUrl: string | null = null;
  const first = await fbGet(path, { ...params, limit: "200" });
  all.push(...((first.data as Json[]) ?? []));
  nextUrl = ((first.paging as Json | undefined)?.next as string) ?? null;
  while (nextUrl) {
    const r = await fetch(nextUrl);
    const body = (await r.json()) as Json;
    if (!r.ok) break;
    all.push(...((body.data as Json[]) ?? []));
    nextUrl = ((body.paging as Json | undefined)?.next as string) ?? null;
  }
  return all;
}

async function spendingIds(account: string, level: "campaign" | "adset" | "ad"): Promise<Set<string>> {
  const idField = `${level}_id`;
  const rows = (await fbGetAll(`${account}/insights`, {
    level,
    date_preset: DATE_PRESET,
    fields: `${idField},spend`,
    filtering: JSON.stringify([{ field: "spend", operator: "GREATER_THAN", value: 0 }]),
  })) as Insights[];
  return new Set(rows.map((r) => (r as unknown as Record<string, string>)[idField]).filter(Boolean));
}

function bump<T extends string | number>(m: Map<T, number>, k: T): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

async function assetAccessible(account: string, kind: string, id: string): Promise<boolean> {
  // Try a single-field read against the asset, scoped via the target account where relevant.
  try {
    if (kind === "image_hash") {
      const r = await fbGet(`${account}/adimages`, { hashes: JSON.stringify([id]), fields: "hash" });
      const data = r.data as Json[] | undefined;
      return Array.isArray(data) && data.length > 0;
    }
    if (kind === "custom_audience") {
      // Audiences must be visible to the target account; querying directly works if shared.
      await fbGet(id, { fields: "id,name" });
      return true;
    }
    if (kind === "pixel") {
      const r = await fbGet(`${account}/adspixels`, { fields: "id" });
      const data = (r.data as Json[] | undefined) ?? [];
      return data.some((p) => p.id === id);
    }
    if (kind === "product_catalog") {
      await fbGet(id, { fields: "id,name" });
      return true;
    }
    if (kind === "page" || kind === "video" || kind === "post") {
      await fbGet(id, { fields: "id" });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log(`Auditing ${OLD_ACCOUNT} → ${NEW_ACCOUNT}\n`);

  // 1. Find spending entities at each level
  console.log("Step 1/4: Finding spending entities (last 90d)…");
  const [spendCampaigns, spendAdsets, spendAds] = await Promise.all([
    spendingIds(OLD_ACCOUNT, "campaign"),
    spendingIds(OLD_ACCOUNT, "adset"),
    spendingIds(OLD_ACCOUNT, "ad"),
  ]);
  console.log(`  campaigns=${spendCampaigns.size} adsets=${spendAdsets.size} ads=${spendAds.size}\n`);

  // 2. Fetch campaign details
  console.log("Step 2/4: Fetching campaign details…");
  const campaigns: Json[] = [];
  for (const id of spendCampaigns) {
    const c = await fbGet(id, {
      fields: "id,name,objective,buying_type,special_ad_categories,status,bid_strategy,daily_budget,lifetime_budget,promoted_object",
    });
    campaigns.push(c);
  }

  // 3. Fetch adset details, filtered to spending adsets only
  console.log("Step 3/4: Fetching adset details…");
  const adsets: Json[] = [];
  for (const campaignId of spendCampaigns) {
    const list = await fbGetAll(`${campaignId}/adsets`, {
      fields:
        "id,name,status,campaign_id,daily_budget,lifetime_budget,bid_amount,bid_strategy,billing_event,optimization_goal,targeting,promoted_object,start_time,end_time,attribution_spec,destination_type",
    });
    for (const a of list) {
      if (spendAdsets.has(a.id as string)) adsets.push(a);
    }
  }

  // 4. Fetch ad details + creatives, filtered to spending ads only
  console.log("Step 4/4: Fetching ads + creatives…");
  const ads: Json[] = [];
  const creatives: Json[] = [];
  const seenCreatives = new Set<string>();
  for (const adsetId of spendAdsets) {
    const list = await fbGetAll(`${adsetId}/ads`, {
      fields:
        "id,name,status,adset_id,campaign_id,tracking_specs,conversion_specs,creative{id,name,object_story_id,object_story_spec,image_hash,video_id,thumbnail_url,effective_object_story_id,asset_feed_spec,instagram_actor_id,template_url,url_tags,call_to_action_type,degrees_of_freedom_spec,object_type}",
    });
    for (const a of list) {
      if (!spendAds.has(a.id as string)) continue;
      ads.push(a);
      const cr = a.creative as Json | undefined;
      if (cr?.id && !seenCreatives.has(cr.id as string)) {
        seenCreatives.add(cr.id as string);
        creatives.push(cr);
      }
    }
  }

  // 5. Extract referenced asset IDs
  const pages = new Map<string, number>();
  const igActors = new Map<string, number>();
  const pixels = new Map<string, number>();
  const audiences = new Map<string, number>();
  const catalogs = new Map<string, number>();
  const imageHashes = new Map<string, number>();
  const videoIds = new Map<string, number>();
  const postIds = new Map<string, number>();
  const customConversions = new Map<string, number>();

  for (const c of campaigns) {
    const po = c.promoted_object as Json | undefined;
    if (po?.pixel_id) bump(pixels, po.pixel_id as string);
    if (po?.product_catalog_id) bump(catalogs, po.product_catalog_id as string);
    if (po?.custom_conversion_id) bump(customConversions, po.custom_conversion_id as string);
  }
  for (const a of adsets) {
    const po = a.promoted_object as Json | undefined;
    if (po?.pixel_id) bump(pixels, po.pixel_id as string);
    if (po?.page_id) bump(pages, po.page_id as string);
    if (po?.product_catalog_id) bump(catalogs, po.product_catalog_id as string);
    if (po?.custom_conversion_id) bump(customConversions, po.custom_conversion_id as string);
    const tgt = a.targeting as Json | undefined;
    if (tgt) {
      for (const key of ["custom_audiences", "excluded_custom_audiences"] as const) {
        const arr = tgt[key] as Json[] | undefined;
        if (Array.isArray(arr)) for (const x of arr) if (x.id) bump(audiences, x.id as string);
      }
    }
  }
  for (const cr of creatives) {
    if (cr.image_hash) bump(imageHashes, cr.image_hash as string);
    if (cr.video_id) bump(videoIds, cr.video_id as string);
    if (cr.instagram_actor_id) bump(igActors, cr.instagram_actor_id as string);
    if (cr.effective_object_story_id) bump(postIds, cr.effective_object_story_id as string);
    const oss = cr.object_story_spec as Json | undefined;
    if (oss?.page_id) bump(pages, oss.page_id as string);
    if (oss?.instagram_actor_id) bump(igActors, oss.instagram_actor_id as string);
    const ld = oss?.link_data as Json | undefined;
    if (ld?.image_hash) bump(imageHashes, ld.image_hash as string);
    const vd = oss?.video_data as Json | undefined;
    if (vd?.video_id) bump(videoIds, vd.video_id as string);
    if (vd?.image_hash) bump(imageHashes, vd.image_hash as string);
    const pd = oss?.photo_data as Json | undefined;
    if (pd?.image_hash) bump(imageHashes, pd.image_hash as string);
  }

  // 6. Check accessibility from NEW account
  console.log("\nChecking asset accessibility from new account…");
  async function checkBatch(kind: string, ids: string[]): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const id of ids) {
      out[id] = await assetAccessible(NEW_ACCOUNT, kind, id);
    }
    return out;
  }

  const access = {
    pages: await checkBatch("page", [...pages.keys()]),
    pixels: await checkBatch("pixel", [...pixels.keys()]),
    audiences: await checkBatch("custom_audience", [...audiences.keys()]),
    catalogs: await checkBatch("product_catalog", [...catalogs.keys()]),
    imageHashes: await checkBatch("image_hash", [...imageHashes.keys()]),
    videos: await checkBatch("video", [...videoIds.keys()]),
    posts: await checkBatch("post", [...postIds.keys()]),
  };

  const manifest = {
    generated_at: new Date().toISOString(),
    old_account: OLD_ACCOUNT,
    new_account: NEW_ACCOUNT,
    date_preset: DATE_PRESET,
    counts: {
      campaigns: campaigns.length,
      adsets: adsets.length,
      ads: ads.length,
      creatives: creatives.length,
    },
    assets: {
      pages: Object.fromEntries(pages),
      ig_actors: Object.fromEntries(igActors),
      pixels: Object.fromEntries(pixels),
      audiences: Object.fromEntries(audiences),
      catalogs: Object.fromEntries(catalogs),
      image_hashes: Object.fromEntries(imageHashes),
      video_ids: Object.fromEntries(videoIds),
      post_ids: Object.fromEntries(postIds),
      custom_conversions: Object.fromEntries(customConversions),
    },
    accessibility_from_new_account: access,
    campaigns,
    adsets,
    ads,
    creatives,
  };

  writeFileSync(OUTPUT, JSON.stringify(manifest, null, 2));
  console.log(`\n✅ Manifest → ${OUTPUT}`);

  // Summary
  const missing = {
    pages: Object.entries(access.pages).filter(([, v]) => !v).map(([k]) => k),
    pixels: Object.entries(access.pixels).filter(([, v]) => !v).map(([k]) => k),
    audiences: Object.entries(access.audiences).filter(([, v]) => !v).map(([k]) => k),
    catalogs: Object.entries(access.catalogs).filter(([, v]) => !v).map(([k]) => k),
    imageHashes: Object.entries(access.imageHashes).filter(([, v]) => !v).map(([k]) => k),
    videos: Object.entries(access.videos).filter(([, v]) => !v).map(([k]) => k),
    posts: Object.entries(access.posts).filter(([, v]) => !v).map(([k]) => k),
  };

  console.log("\n=== SUMMARY ===");
  console.log(`Campaigns: ${manifest.counts.campaigns}`);
  console.log(`Adsets:    ${manifest.counts.adsets}`);
  console.log(`Ads:       ${manifest.counts.ads}`);
  console.log(`Creatives: ${manifest.counts.creatives}`);
  console.log(`\nDistinct asset references:`);
  console.log(`  pages=${pages.size}  ig_actors=${igActors.size}  pixels=${pixels.size}`);
  console.log(`  audiences=${audiences.size}  catalogs=${catalogs.size}`);
  console.log(`  image_hashes=${imageHashes.size}  video_ids=${videoIds.size}  post_ids=${postIds.size}`);
  console.log(`  custom_conversions=${customConversions.size}`);
  console.log(`\nMissing from new account:`);
  for (const [k, v] of Object.entries(missing)) {
    console.log(`  ${k}: ${v.length}${v.length ? "  " + v.slice(0, 5).join(", ") + (v.length > 5 ? "…" : "") : ""}`);
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
