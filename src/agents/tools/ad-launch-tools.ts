/**
 * Ad Launch Tools for Ada (Phase 11)
 *
 * Thin HTTP wrappers around the BMAD droplet's /api/ada/* endpoints. Enables Ada
 * to preview, launch, and pause ad creation flows for clients that AOT
 * media-buys (i.e., clients present in safe_meta_api.py CLIENT_CONFIGS).
 *
 * For upload-only clients (Sweetspot, Audibene), launch tools return
 * launch=false from getClientCapabilities and Ada should not call launch endpoints.
 *
 * All endpoints require X-API-Key header (env.DROPLET_API_KEY) matching API_SECRET
 * on the droplet. See BMAD docs/specs/ada-evolution.md Phase 11 and
 * pma/tools/creative-uploader/server.py /api/ada/*.
 *
 * Hard rule from [[ada-meta-no-delete]] in memory: pause is the only "undo" verb.
 * There is intentionally no `rollbackLaunch`, `deleteAd`, or any other delete-capable
 * tool. Ada must use Ads Manager language only when the user asks to delete: explain
 * she cannot and walk them through it manually.
 */

import { env } from "../../env.js";
import { logger } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// HTTP helper — supports GET + POST + X-API-Key auth
// ---------------------------------------------------------------------------

function getDropletUrl(): string {
  return env.DROPLET_URL || "http://139.59.144.194:8080";
}

function getApiKey(): string {
  // env.DROPLET_API_KEY must equal API_SECRET on the droplet (/root/.env).
  // Set it in DAI production env per docs/ada-launch-flow-handoff.md.
  return (env as any).DROPLET_API_KEY || "";
}

async function dropletRequest<T = unknown>(
  endpoint: string,
  options: {
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
    timeoutMs?: number;
  } = {},
): Promise<{ data?: T; error?: string }> {
  const url = `${getDropletUrl()}${endpoint}`;
  const method = options.method ?? "POST";
  const timeoutMs = options.timeoutMs ?? 120_000;
  const apiKey = getApiKey();

  if (!apiKey) {
    return {
      error:
        "DROPLET_API_KEY not set in DAI env. Set it to match API_SECRET on the BMAD droplet " +
        "(/root/.env). Required by /api/ada/* endpoints.",
    };
  }

  logger.debug({ url, method }, "Ada launch droplet request");

  try {
    const init: RequestInit = {
      method,
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(url, init);
    const data = await response.json();
    if (!response.ok) {
      const detail = (data as Record<string, unknown>).detail ?? JSON.stringify(data);
      logger.error({ status: response.status, detail }, "Ada launch droplet error");
      return { error: `Droplet error (${response.status}): ${detail}` };
    }
    return { data: data as T };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "Ada launch droplet request failed");
    return { error: `Failed to reach droplet: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface CreativeInput {
  video_id: string;
  filename?: string;
  asset_id?: string;
  media_type?: "video" | "image";
  transcript?: string;
  visual_summary?: string;
}

export interface ClientCapabilities {
  client_code: string;
  upload: boolean;
  launch: boolean;
  locked_campaign_name: string | null;
  has_meta_config: boolean;
  has_voice_qc: boolean;
  voice_qc_persona: string | null;
}

// ---------------------------------------------------------------------------
// getClientCapabilities — pre-flight: is this client launch-eligible?
// ---------------------------------------------------------------------------

/**
 * Return whether Ada can launch ads for this client, plus the locked sandbox campaign name.
 * Use this AFTER upload_to_media_library completes — if launch=false, Ada should confirm the
 * upload and stop (the client is upload-only, e.g. Sweetspot/Audibene). If launch=true, Ada
 * should ask the user whether to proceed with previewAdLaunch.
 */
export async function getClientCapabilities(params: {
  client_code: string;
}): Promise<string> {
  const { data, error } = await dropletRequest<ClientCapabilities>(
    `/api/ada/clients/${encodeURIComponent(params.client_code.toUpperCase())}/capabilities`,
    { method: "GET", timeoutMs: 10_000 },
  );
  if (error) return JSON.stringify({ error });
  return JSON.stringify(data);
}

// ---------------------------------------------------------------------------
// previewAdLaunch — build a preview, no Meta side effects
// ---------------------------------------------------------------------------

/**
 * Build a launch preview against a client's locked sandbox campaign. NO Meta side
 * effects — this just resolves landing pages, generates copy via Opus, runs QC, and
 * persists a pending launch_batches row. Returns the batch_id and the full preview
 * payload which the Slack listener renders as a Block Kit message with approval buttons.
 *
 * For uploaded creatives without explicit transcript / visual_summary, the droplet
 * falls back to media_library_assets cache (transcript + visual fetched
 * automatically when the videos were uploaded via /api/media-library/upload).
 */
export async function previewAdLaunch(params: {
  client_code: string;
  creatives: CreativeInput[];
  mode?: "new_adset" | "ads_only";
  target_adset_id?: string;
  brief_notion_id?: string;
  source_drive_url?: string;
  initiated_by?: string;
  geo_tier?: "US" | "T1" | "T2";
  scheduled_for?: string;
  /** Ad-set concept/angle name (e.g. "Auction-Win-Dirk"). For clients who name ad sets by
   *  concept rather than from a Notion ad-set DB (Sweetspot/SS). WINS over the server's
   *  Notion-title / lander-keyword derivation, so only pass it when the concept is the right
   *  ad-set name — never for clients whose ad sets are named from Notion. */
  concept?: string;
}): Promise<string> {
  const body: Record<string, unknown> = {
    client_code: params.client_code.toUpperCase(),
    creatives: params.creatives,
    mode: params.mode ?? "new_adset",
  };
  if (params.target_adset_id) body.target_adset_id = params.target_adset_id;
  if (params.brief_notion_id) body.brief_notion_id = params.brief_notion_id;
  if (params.source_drive_url) body.source_drive_url = params.source_drive_url;
  if (params.initiated_by) body.initiated_by = params.initiated_by;
  if (params.geo_tier) body.geo_tier = params.geo_tier;
  if (params.scheduled_for) body.scheduled_for = params.scheduled_for;
  if (params.concept) body.concept = params.concept;

  const { data, error } = await dropletRequest(
    "/api/ada/preview-launch",
    { method: "POST", body, timeoutMs: 120_000 },  // up to 2min for Opus copy gen per creative
  );
  if (error) return JSON.stringify({ error });
  return JSON.stringify(data);
}

// ---------------------------------------------------------------------------
// launchAds — execute the preview against Meta. PAUSED writes only.
// ---------------------------------------------------------------------------

/**
 * Execute a previously-previewed launch. Creates a PAUSED adset (in new_adset mode)
 * and PAUSED ads in the client's locked sandbox campaign. Idempotent: a second call
 * with the same idempotency_key returns the original result without writing again.
 *
 * Typically called from a Slack button handler with idempotency_key derived from the
 * button click timestamp (stable across Slack retries).
 */
export async function launchAds(params: {
  batch_id: string;
  idempotency_key: string;
  edits?: {
    lander_overrides?: Record<string, string>;
    ad_overrides?: Record<string, { primary_text?: string; headline?: string; description?: string }>;
    adset_name?: string;
    ad_name_overrides?: Record<string, string>;
    allow_duplicate_asset_id?: boolean;
  };
}): Promise<string> {
  const body: Record<string, unknown> = {
    batch_id: params.batch_id,
    idempotency_key: params.idempotency_key,
  };
  if (params.edits) body.edits = params.edits;

  const { data, error } = await dropletRequest(
    "/api/ada/launch",
    { method: "POST", body, timeoutMs: 600_000 },  // up to 10min for multi-ad batches with Meta latency
  );
  if (error) return JSON.stringify({ error });
  return JSON.stringify(data);
}

// ---------------------------------------------------------------------------
// pauseLaunch — Ada's ONLY undo verb. Flips status to PAUSED on adset + ads.
// ---------------------------------------------------------------------------

/**
 * Pause a launched batch. Refuses if status != 'launched'. Flips both the adset and
 * every ad in the batch to configured_status=PAUSED via Meta API. Always reversible
 * (a media buyer can flip back to ACTIVE in Ads Manager). Per [[ada-meta-no-delete]]
 * this is the only undo Ada has — never offer "delete" or "rollback".
 */
export async function pauseLaunch(params: {
  batch_id: string;
  reason: string;
}): Promise<string> {
  const { data, error } = await dropletRequest(
    "/api/ada/pause",
    { method: "POST", body: params, timeoutMs: 120_000 },
  );
  if (error) return JSON.stringify({ error });
  return JSON.stringify(data);
}

// ---------------------------------------------------------------------------
// updateLandingPageMapping — persist a user-corrected URL mapping
// ---------------------------------------------------------------------------

/**
 * Update the landing_pages mapping for a (client, keyword) pair in client_meta_configs.
 * Called when a user says "for PL ginger ads, use /products/wellness-shot-pack" — Ada
 * makes the change stick rather than treating it as a one-off override.
 *
 * Two input shapes:
 *  - single URL replacing the keyword's whole list: { client_code, keyword, url, label? }
 *  - explicit ordered list:                          { client_code, keyword, urls: [{url, label}, ...] }
 */
export async function updateLandingPageMapping(params: {
  client_code: string;
  keyword: string;
  url?: string;
  urls?: Array<{ url: string; label?: string }>;
  label?: string;
  source?: "user_correction" | "manual" | "mining";
}): Promise<string> {
  const body: Record<string, unknown> = {
    client_code: params.client_code.toUpperCase(),
    keyword: params.keyword,
    source: params.source ?? "user_correction",
  };
  if (params.urls) body.urls = params.urls;
  else if (params.url) {
    body.url = params.url;
    if (params.label) body.label = params.label;
  }

  const { data, error } = await dropletRequest(
    "/api/ada/update-lander",
    { method: "POST", body, timeoutMs: 30_000 },
  );
  if (error) return JSON.stringify({ error });
  return JSON.stringify(data);
}

// ---------------------------------------------------------------------------
// qcCopy — client-voice QC (Stella/Steven/Alex) before Gate 3
// ---------------------------------------------------------------------------

/**
 * Run the client's voice-QC pass (the /laori-stella-qc, /audibene-steven-qc,
 * /teethlovers-alex-qc skills, ported server-side) on generated copy BEFORE showing
 * the user a launch preview. Returns a per-creative verdict (ship/revise/block) plus
 * compliance + voice flags and suggested `rewrites`. Apply the rewrites by passing
 * them as `edits.ad_overrides` to launchAds — this tool never writes to Meta.
 *
 * Pass either the generated `creatives` copy, or a `batch_id` to pull copy from a
 * preview. Clients with no QC skill pass through with verdict="ship" + a note — that's
 * expected, not an error.
 */
export async function qcCopy(params: {
  client_code: string;
  creatives?: Array<{
    asset_id?: string;
    video_id?: string;
    image_hash?: string;
    media_type?: "video" | "image";
    primary_text?: string;
    headline?: string;
    description?: string;
    hook?: string;
    sku_hint?: string;
    language?: string;
  }>;
  batch_id?: string;
}): Promise<string> {
  const body: Record<string, unknown> = { client_code: params.client_code.toUpperCase() };
  if (params.creatives) body.creatives = params.creatives;
  if (params.batch_id) body.batch_id = params.batch_id;
  const { data, error } = await dropletRequest("/api/ada/qc", {
    method: "POST",
    body,
    timeoutMs: 120_000,
  });
  if (error) return JSON.stringify({ error });
  return JSON.stringify(data);
}

// ---------------------------------------------------------------------------
// verifyLaunch — post-launch structural verification (MANDATORY after launchAds)
// ---------------------------------------------------------------------------

/**
 * After every launchAds, verify the result is structurally correct on Meta — a 200
 * from launch only means the API call succeeded, NOT that the adset landed in the
 * right campaign / page+IG matched / LP stuck / name rendered without `// null //`
 * artifacts. Returns verdict 🟢 OK / 🟡 WARN / 🔴 FAIL + findings. Never skip this.
 *
 * Input: { batch_id } (preferred) OR { adset_id, client_code }.
 */
export async function verifyLaunch(params: {
  batch_id?: string;
  adset_id?: string;
  client_code?: string;
}): Promise<string> {
  const body: Record<string, unknown> = {};
  if (params.batch_id) body.batch_id = params.batch_id;
  if (params.adset_id) body.adset_id = params.adset_id;
  if (params.client_code) body.client_code = params.client_code.toUpperCase();
  const { data, error } = await dropletRequest("/api/ada/verify", {
    method: "POST",
    body,
    timeoutMs: 60_000,
  });
  if (error) return JSON.stringify({ error });
  return JSON.stringify(data);
}

// ---------------------------------------------------------------------------
// pollAnalysis — transcript/visual readiness gate (before preview-launch)
// ---------------------------------------------------------------------------

/**
 * Check whether uploaded videos have finished transcript + visual analysis. Run this
 * after upload_to_media_library and BEFORE previewAdLaunch — without analysis, copy
 * generation returns usable=false. Non-blocking by default (timeout_seconds=0 = single
 * snapshot); pass a small timeout_seconds (≤180) to wait briefly for in-flight work.
 */
export async function pollAnalysis(params: {
  client_code: string;
  meta_video_ids: string[];
  timeout_seconds?: number;
}): Promise<string> {
  const { data, error } = await dropletRequest("/api/ada/analysis-status", {
    method: "POST",
    body: {
      client_code: params.client_code.toUpperCase(),
      meta_video_ids: params.meta_video_ids,
      timeout_seconds: params.timeout_seconds ?? 0,
    },
    timeoutMs: 200_000,
  });
  if (error) return JSON.stringify({ error });
  return JSON.stringify(data);
}

// ---------------------------------------------------------------------------
// setAdsetMarker — visible (🔴 …) TODO marker on an adset name (Gate 4 follow-ups)
// ---------------------------------------------------------------------------

/**
 * Prepend a visible `(🔴 <ACTION>) ` marker to an adset's Meta name so anyone in Ads
 * Manager sees a pending action before flipping it ACTIVE. Use for fallback-LP launches
 * (`SWAP LP`), pending copy edits, etc. Cleared manually in Ads Manager (no programmatic
 * clear by design). Idempotent — re-applying the same marker is a no-op.
 */
export async function setAdsetMarker(params: {
  client_code: string;
  adset_id: string;
  marker_text: string;
}): Promise<string> {
  const { data, error } = await dropletRequest("/api/ada/adset-marker", {
    method: "POST",
    body: {
      client_code: params.client_code.toUpperCase(),
      adset_id: params.adset_id,
      marker_text: params.marker_text,
    },
    timeoutMs: 30_000,
  });
  if (error) return JSON.stringify({ error });
  return JSON.stringify(data);
}
