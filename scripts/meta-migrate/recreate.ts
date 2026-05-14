/**
 * Meta Migration — Path B: Structural recreation
 *
 * Reads manifest.json, then for each in-scope campaign/adset/ad creates a
 * new entity in the target ad account via the appropriate POST endpoint.
 * Cross-account /copies isn't supported by Meta (parent_id silently
 * ignored), so we rebuild field-by-field.
 *
 * Creatives: reuse the original Page post via object_story_id where the
 * source ad has an effective_object_story_id. This preserves social proof
 * (likes/comments accumulate on the same post) and avoids having to claim
 * image hashes in the new account. Ads without a rendered page post fall
 * back to a minimal creative spec from the source object_story_spec.
 *
 * Resumable: writes id-map.json after each successful create.
 * Errors append to errors.log; reruns with --resume skip mapped entities.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/meta-migrate/recreate.ts -- --dry-run
 *   pnpm tsx --env-file=.env scripts/meta-migrate/recreate.ts -- --campaign 120244512990470066
 *   pnpm tsx --env-file=.env scripts/meta-migrate/recreate.ts -- --resume
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.META_ADS_ACCESS_TOKEN;
const OLD_ACCOUNT = "act_1814118775391116";
const OLD_ACCOUNT_NUMERIC = OLD_ACCOUNT.replace("act_", "");
const NEW_ACCOUNT = "act_978593421213192";
const DIR = join(process.cwd(), "scripts/meta-migrate");
const MANIFEST = join(DIR, "manifest.json");
const ID_MAP = join(DIR, "id-map.json");
const ERR_LOG = join(DIR, "errors.log");
const IMG_MAP = join(DIR, "image-hash-map.json"); // hash → claimed_in_new

if (!TOKEN) {
  console.error("META_ADS_ACCESS_TOKEN missing");
  process.exit(1);
}

const DRY_RUN = process.argv.includes("--dry-run");
const CAMPAIGN_IDX = process.argv.indexOf("--campaign");
const CAMPAIGN_FILTER = CAMPAIGN_IDX > -1 ? process.argv[CAMPAIGN_IDX + 1] : null;

type Json = Record<string, unknown>;

type IdMap = {
  campaigns: Record<string, string>;
  adsets: Record<string, string>;
  creatives: Record<string, string>;
  ads: Record<string, string>;
};

function loadIdMap(): IdMap {
  if (existsSync(ID_MAP)) {
    const parsed = JSON.parse(readFileSync(ID_MAP, "utf8")) as Partial<IdMap>;
    return {
      campaigns: parsed.campaigns ?? {},
      adsets: parsed.adsets ?? {},
      creatives: parsed.creatives ?? {},
      ads: parsed.ads ?? {},
    };
  }
  return { campaigns: {}, adsets: {}, creatives: {}, ads: {} };
}

function saveIdMap(map: IdMap): void {
  writeFileSync(ID_MAP, JSON.stringify(map, null, 2));
}

function logError(stage: string, oldId: string, err: unknown): void {
  const line = `[${new Date().toISOString()}] ${stage} ${oldId}: ${typeof err === "string" ? err : JSON.stringify(err)}\n`;
  appendFileSync(ERR_LOG, line);
  console.error(`  ❌ ${stage} ${oldId}: ${typeof err === "string" ? err : JSON.stringify(err)}`);
}

async function fbPost(path: string, body: Record<string, string>): Promise<Json> {
  const url = `${API}/${path}`;
  const form = new URLSearchParams();
  form.set("access_token", TOKEN!);
  for (const [k, v] of Object.entries(body)) form.set(k, v);
  const r = await fetch(url, { method: "POST", body: form });
  const json = (await r.json()) as Json;
  if (!r.ok) return { _error: json.error ?? json };
  return json;
}

// ---------------------------------------------------------------------------
// Image hash claim helper
// ---------------------------------------------------------------------------

function loadImageMap(): Record<string, boolean> {
  if (existsSync(IMG_MAP)) return JSON.parse(readFileSync(IMG_MAP, "utf8")) as Record<string, boolean>;
  return {};
}

function saveImageMap(map: Record<string, boolean>): void {
  writeFileSync(IMG_MAP, JSON.stringify(map, null, 2));
}

const imageMap = loadImageMap();

async function claimImageHash(hash: string): Promise<boolean> {
  if (imageMap[hash]) return true;
  if (DRY_RUN) {
    console.log(`    DRY: POST /${NEW_ACCOUNT}/adimages  copy_from={hash:${hash}, source_account_id:${OLD_ACCOUNT_NUMERIC}}`);
    imageMap[hash] = true;
    return true;
  }
  const resp = await fbPost(`${NEW_ACCOUNT}/adimages`, {
    copy_from: JSON.stringify({ hash, source_account_id: OLD_ACCOUNT_NUMERIC }),
  });
  if (resp._error) {
    console.error(`    ❌ claim ${hash}: ${JSON.stringify(resp._error)}`);
    return false;
  }
  imageMap[hash] = true;
  saveImageMap(imageMap);
  return true;
}

function extractImageHashesFromAssetFeedSpec(afs: Json): string[] {
  const hashes = new Set<string>();
  const images = afs.images as Json[] | undefined;
  if (Array.isArray(images)) {
    for (const img of images) {
      if (img.hash) hashes.add(img.hash as string);
    }
  }
  const videos = afs.videos as Json[] | undefined;
  if (Array.isArray(videos)) {
    for (const vid of videos) {
      const thumb = vid.thumbnail_hash as string | undefined;
      if (thumb) hashes.add(thumb);
    }
  }
  return [...hashes];
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function buildCampaignPayload(c: Json): Record<string, string> {
  const out: Record<string, string> = {
    name: String(c.name ?? ""),
    objective: String(c.objective ?? "OUTCOME_TRAFFIC"),
    status: "PAUSED",
    special_ad_categories: JSON.stringify(c.special_ad_categories ?? []),
    buying_type: String(c.buying_type ?? "AUCTION"),
  };
  if (c.bid_strategy) out.bid_strategy = String(c.bid_strategy);
  if (c.daily_budget) out.daily_budget = String(c.daily_budget);
  if (c.lifetime_budget) out.lifetime_budget = String(c.lifetime_budget);
  if (c.promoted_object) out.promoted_object = JSON.stringify(c.promoted_object);
  return out;
}

function buildAdsetPayload(a: Json, newCampaignId: string): Record<string, string> {
  const out: Record<string, string> = {
    name: String(a.name ?? ""),
    campaign_id: newCampaignId,
    status: "PAUSED",
    billing_event: String(a.billing_event ?? "IMPRESSIONS"),
    optimization_goal: String(a.optimization_goal ?? "OFFSITE_CONVERSIONS"),
  };
  if (a.daily_budget) out.daily_budget = String(a.daily_budget);
  if (a.lifetime_budget) out.lifetime_budget = String(a.lifetime_budget);
  if (a.bid_amount) out.bid_amount = String(a.bid_amount);
  if (a.bid_strategy) out.bid_strategy = String(a.bid_strategy);
  if (a.targeting) {
    // Meta validation (added late 2025/2026): if instagram_positions includes
    // "explore_home" it must also include "explore".
    const t = JSON.parse(JSON.stringify(a.targeting)) as Json;
    const ig = t.instagram_positions as string[] | undefined;
    if (Array.isArray(ig) && ig.includes("explore_home") && !ig.includes("explore")) {
      t.instagram_positions = [...ig, "explore"];
    }
    out.targeting = JSON.stringify(t);
  }
  if (a.promoted_object) out.promoted_object = JSON.stringify(a.promoted_object);
  if (a.attribution_spec) out.attribution_spec = JSON.stringify(a.attribution_spec);
  if (a.destination_type && a.destination_type !== "UNDEFINED") {
    out.destination_type = String(a.destination_type);
  }
  // Skip start_time / end_time if past — keeping a past end_time makes Meta reject.
  if (a.start_time && new Date(String(a.start_time)).getTime() > Date.now()) {
    out.start_time = String(a.start_time);
  }
  if (a.end_time && new Date(String(a.end_time)).getTime() > Date.now()) {
    out.end_time = String(a.end_time);
  }
  return out;
}

async function buildCreativePayload(creative: Json): Promise<Record<string, string> | null> {
  const name = String(creative.name ?? `migrated_creative_${Date.now()}`);
  const out: Record<string, string> = { name };
  if (creative.url_tags) out.url_tags = String(creative.url_tags);

  // Primary path: reuse the existing Page post via object_story_id.
  // Preserves social proof. Confirmed to work for ~58% of ads (those without
  // catalog templates). Catalog-template ads fail here with "Dynamic creative
  // missing product set ID" — they need a non-API solution (manual rebuild or
  // CSV bulk import). We don't try the asset_feed_spec fallback because:
  //   - 49% of AC ads are video-only and Meta doesn't cleanly cross-account videos
  //   - asset_feed_spec posts also hit the dynamic-creative wall when the page
  //     post is already dynamic
  const effectivePost = creative.effective_object_story_id as string | undefined;
  if (effectivePost) {
    out.object_story_id = effectivePost;
    return out;
  }

  // Last resort: clone object_story_spec verbatim — claim any embedded image hashes.
  const oss = creative.object_story_spec as Json | undefined;
  if (oss) {
    const ossHashes = new Set<string>();
    for (const key of ["link_data", "video_data", "photo_data"] as const) {
      const v = oss[key] as Json | undefined;
      if (v?.image_hash) ossHashes.add(v.image_hash as string);
    }
    for (const h of ossHashes) {
      await claimImageHash(h);
    }
    out.object_story_spec = JSON.stringify(oss);
    return out;
  }

  return null;
}

function buildAdPayload(ad: Json, newAdsetId: string, newCreativeId: string): Record<string, string> {
  return {
    name: String(ad.name ?? ""),
    adset_id: newAdsetId,
    status: "PAUSED",
    creative: JSON.stringify({ creative_id: newCreativeId }),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!existsSync(MANIFEST)) {
    console.error(`Missing ${MANIFEST}. Run audit.ts first.`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    campaigns: Json[];
    adsets: Json[];
    ads: Json[];
    creatives: Json[];
  };
  const creativesById = new Map<string, Json>();
  for (const cr of manifest.creatives) creativesById.set(cr.id as string, cr);

  const idMap = loadIdMap();

  let campaigns = manifest.campaigns;
  if (CAMPAIGN_FILTER) campaigns = campaigns.filter((c) => c.id === CAMPAIGN_FILTER);

  const inScopeCampaignIds = new Set(campaigns.map((c) => c.id as string));
  const adsets = manifest.adsets.filter((a) => inScopeCampaignIds.has(a.campaign_id as string));
  const inScopeAdsetIds = new Set(adsets.map((a) => a.id as string));
  const ads = manifest.ads.filter((a) => inScopeAdsetIds.has(a.adset_id as string));

  console.log(`Mode: ${DRY_RUN ? "DRY-RUN" : "LIVE"}`);
  console.log(`Target: ${NEW_ACCOUNT}`);
  console.log(`In scope: ${campaigns.length} campaigns, ${adsets.length} adsets, ${ads.length} ads\n`);

  // ---- Campaigns ----
  for (const c of campaigns) {
    const oldId = c.id as string;
    if (idMap.campaigns[oldId]) {
      console.log(`[campaign] ${oldId} → ${idMap.campaigns[oldId]} (already mapped)`);
      continue;
    }
    const payload = buildCampaignPayload(c);
    console.log(`[campaign] ${oldId}  "${c.name}"`);
    if (DRY_RUN) {
      console.log(`  DRY: POST /${NEW_ACCOUNT}/campaigns  ${JSON.stringify(payload)}`);
      continue;
    }
    const resp = await fbPost(`${NEW_ACCOUNT}/campaigns`, payload);
    if (resp._error) {
      logError("campaign", oldId, resp._error);
      continue;
    }
    const newId = resp.id as string;
    idMap.campaigns[oldId] = newId;
    saveIdMap(idMap);
    console.log(`  ✓ ${newId}`);
  }

  // ---- Adsets ----
  for (const a of adsets) {
    const oldId = a.id as string;
    if (idMap.adsets[oldId]) {
      console.log(`[adset]    ${oldId} → ${idMap.adsets[oldId]} (already mapped)`);
      continue;
    }
    const newCampaignId = idMap.campaigns[a.campaign_id as string];
    if (!newCampaignId && !DRY_RUN) {
      logError("adset", oldId, `No new campaign id for ${a.campaign_id}`);
      continue;
    }
    const payload = buildAdsetPayload(a, newCampaignId ?? "<new-campaign>");
    console.log(`[adset]    ${oldId}  "${a.name}"`);
    if (DRY_RUN) {
      console.log(`  DRY: POST /${NEW_ACCOUNT}/adsets  ${JSON.stringify(payload).slice(0, 200)}…`);
      continue;
    }
    const resp = await fbPost(`${NEW_ACCOUNT}/adsets`, payload);
    if (resp._error) {
      logError("adset", oldId, resp._error);
      continue;
    }
    const newId = resp.id as string;
    idMap.adsets[oldId] = newId;
    saveIdMap(idMap);
    console.log(`  ✓ ${newId}`);
  }

  // ---- Creatives + Ads ----
  for (const ad of ads) {
    const oldId = ad.id as string;
    if (idMap.ads[oldId]) {
      console.log(`[ad]       ${oldId} → ${idMap.ads[oldId]} (already mapped)`);
      continue;
    }
    const newAdsetId = idMap.adsets[ad.adset_id as string];
    if (!newAdsetId && !DRY_RUN) {
      logError("ad", oldId, `No new adset id for ${ad.adset_id}`);
      continue;
    }

    const adCreative = ad.creative as Json | undefined;
    const oldCreativeId = adCreative?.id as string | undefined;
    let newCreativeId = oldCreativeId ? idMap.creatives[oldCreativeId] : undefined;

    if (!newCreativeId) {
      const creativeSource = oldCreativeId ? creativesById.get(oldCreativeId) ?? adCreative : adCreative;
      if (!creativeSource) {
        logError("ad", oldId, "No creative on source ad");
        continue;
      }
      const cPayload = await buildCreativePayload(creativeSource);
      if (!cPayload) {
        logError("ad", oldId, "Could not build creative payload");
        continue;
      }
      console.log(`[creative] ${oldCreativeId ?? "<inline>"}  for ad "${ad.name}"`);
      if (DRY_RUN) {
        console.log(`  DRY: POST /${NEW_ACCOUNT}/adcreatives  ${JSON.stringify(cPayload).slice(0, 200)}…`);
        newCreativeId = "<new-creative>";
      } else {
        const cResp = await fbPost(`${NEW_ACCOUNT}/adcreatives`, cPayload);
        if (cResp._error) {
          logError("creative", oldCreativeId ?? oldId, cResp._error);
          continue;
        }
        newCreativeId = cResp.id as string;
        if (oldCreativeId) idMap.creatives[oldCreativeId] = newCreativeId;
        saveIdMap(idMap);
        console.log(`  ✓ ${newCreativeId}`);
      }
    }

    const adPayload = buildAdPayload(ad, newAdsetId ?? "<new-adset>", newCreativeId);
    console.log(`[ad]       ${oldId}  "${ad.name}"`);
    if (DRY_RUN) {
      console.log(`  DRY: POST /${NEW_ACCOUNT}/ads  ${JSON.stringify(adPayload)}`);
      continue;
    }
    const resp = await fbPost(`${NEW_ACCOUNT}/ads`, adPayload);
    if (resp._error) {
      logError("ad", oldId, resp._error);
      continue;
    }
    const newId = resp.id as string;
    idMap.ads[oldId] = newId;
    saveIdMap(idMap);
    console.log(`  ✓ ${newId}`);
  }

  console.log("\n=== FINAL ===");
  console.log(`Campaigns mapped: ${Object.keys(idMap.campaigns).length}`);
  console.log(`Adsets mapped:    ${Object.keys(idMap.adsets).length}`);
  console.log(`Creatives mapped: ${Object.keys(idMap.creatives).length}`);
  console.log(`Ads mapped:       ${Object.keys(idMap.ads).length}`);
  if (!DRY_RUN) console.log(`\nid-map → ${ID_MAP}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
