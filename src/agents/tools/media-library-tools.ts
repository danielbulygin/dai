/**
 * Media Library Tools for Ada
 *
 * Enables Ada to scan Google Drive folders and upload creatives to the
 * Meta Business Media Library. All heavy lifting happens on the droplet
 * (139.59.144.194:8080); these tools are thin HTTP wrappers.
 *
 * Two-step flow:
 * 1. scan_media_library_folder  - preview files, detect client, check naming
 * 2. upload_to_media_library    - rename in Drive + upload to Meta
 */

import { env } from "../../env.js";
import { logger } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDropletUrl(): string {
  return env.DROPLET_URL || "http://139.59.144.194:8080";
}

async function dropletRequest(
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs: number = 600_000, // 10 min default (uploads take time)
): Promise<{ data?: unknown; error?: string }> {
  const url = `${getDropletUrl()}${endpoint}`;
  logger.debug({ url, body: Object.keys(body) }, "Droplet request");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(env.DROPLET_API_KEY ? { "X-API-Key": env.DROPLET_API_KEY } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const data = await response.json();

    if (!response.ok) {
      const detail = (data as Record<string, unknown>).detail ?? JSON.stringify(data);
      logger.error({ status: response.status, detail }, "Droplet error");
      return { error: `Droplet error (${response.status}): ${detail}` };
    }

    return { data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "Droplet request failed");
    return { error: `Failed to reach droplet: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export interface ScanResult {
  folder_id: string;
  folder_name: string;
  parent_names: string[];
  files: Array<{
    id: string;
    name: string;
    normalized_name: string;
    asset_id: string | null;
    media_type: "video" | "image";
    size: number;
    size_mb: number;
    needs_rename: boolean;
  }>;
  detected_client: string | null;
  business_config: {
    business_id: string;
    folder_id: string;
    name: string;
  } | null;
  summary: {
    total: number;
    videos: number;
    images: number;
    needs_rename: number;
    already_named: number;
  };
}

export interface UploadResult {
  client_code: string;
  ad_account_id: string;
  business_config: {
    business_id: string;
    folder_id: string;
    name: string;
  };
  results: Array<{
    filename: string;
    normalized_name: string;
    asset_id: string | null;
    media_type: "video" | "image";
    video_id?: string;
    image_hash?: string;
    url?: string;
    // v2 statuses: uploaded | uploaded_pending | skipped_title | skipped_hash | error
    status: string;
    error?: string;
    hint?: string;
    renamed_in_drive: boolean;
  }>;
  summary: {
    total: number;
    successful: number;
    uploaded: number;
    uploaded_pending: number;
    skipped_hash: number;
    skipped_title: number;
    failed: number;
    renamed: number;
  };
}

/**
 * Scan a Google Drive folder to preview files, detect client, and check naming.
 */
export async function scanMediaLibraryFolder(params: {
  drive_url: string;
}): Promise<string> {
  const { data, error } = await dropletRequest(
    "/api/media-library/scan",
    { drive_url: params.drive_url },
    120_000, // 2 min timeout for scan
  );

  if (error) {
    return JSON.stringify({ error });
  }

  return JSON.stringify(data);
}

/**
 * Rename files in Google Drive and upload them to Meta Business Media Library.
 *
 * Uses the v2 droplet endpoint: per-client token routing (Growth Squad clients
 * like TL/LA MUST NOT upload with the AOT token — the 2026-06-11 TLx4086 thread
 * failed exactly this way on the old v1 endpoint), content-hash dedup, real
 * library video-id resolution, and the expected_asset_id conflict guard.
 */
export async function uploadToMediaLibrary(params: {
  drive_url: string;
  client_code: string;
  expected_asset_id?: string;
  ad_account_id?: string;
}): Promise<string> {
  const { data, error } = await dropletRequest(
    "/api/media-library/v2/upload",
    {
      drive_url: params.drive_url,
      client_code: params.client_code,
      resolve_real_ids: true,
      ...(params.expected_asset_id ? { expected_asset_id: params.expected_asset_id } : {}),
      ...(params.ad_account_id ? { ad_account_id: params.ad_account_id } : {}),
    },
    2_700_000, // 45 min timeout (large video uploads, 3+ files at ~167MB each)
  );

  if (error) {
    return JSON.stringify({ error });
  }

  // The endpoint returns HTTP 200 even when individual files fail. Promote
  // per-file failures to a top-level `error` so the agent can't read a failed
  // batch as success and so the audit log records the call as failed.
  const upload = data as Partial<UploadResult> | undefined;
  const failed = upload?.summary?.failed ?? 0;
  if (failed > 0) {
    const failures = (upload?.results ?? [])
      .filter((r) => r.status === "error")
      .map((r) => `${r.normalized_name}: ${r.error}${r.hint ? ` (${r.hint})` : ""}`);
    return JSON.stringify({
      error: `${failed}/${upload?.summary?.total ?? "?"} file(s) failed to upload — do NOT proceed to preview/launch. ${failures[0] ?? ""}`,
      failures,
      ...data as Record<string, unknown>,
    });
  }

  return JSON.stringify(data);
}

/**
 * Pre-upload worker state for ad codes (hourly droplet job scheduler-ada_preupload).
 *
 * The worker pre-warms Media Library upload + AssemblyAI/Gemini analysis for
 * every Ready-to-Upload backlog ad set. When `pre_warmed` is true, Ada's gated
 * launch flow can skip the analysis wait entirely: the upload re-call is a fast
 * all-skipped_title no-op that returns the cached video ids, and
 * media_library_assets already holds transcript + visual_summary.
 */
export async function checkPreuploadStatus(params: {
  asset_ids: string[];
}): Promise<string> {
  const { getSupabase } = await import("../../integrations/supabase.js");
  try {
    const supabase = getSupabase();
    const { data: statuses, error } = await supabase
      .from("ada_preupload_status")
      .select(
        "asset_id, client_code, folder_url, files_total, uploaded, failed, flags, analysis_complete, analysis_summary, last_run_at, last_uploaded_at",
      )
      .in("asset_id", params.asset_ids);
    if (error) throw error;

    const { data: assets, error: assetsError } = await supabase
      .from("media_library_assets")
      .select(
        "asset_id, normalized_name, media_type, meta_video_id, meta_image_hash, transcript_status, visual_status",
      )
      .in("asset_id", params.asset_ids);
    if (assetsError) throw assetsError;

    const byCode = params.asset_ids.map((code) => {
      const s = (statuses ?? []).find((r) => r.asset_id === code);
      const rows = (assets ?? []).filter((r) => r.asset_id === code);
      return {
        asset_id: code,
        seen_by_worker: !!s,
        pre_warmed: !!s && s.analysis_complete && (s.flags ?? []).length === 0,
        flags: s?.flags ?? [],
        folder_url: s?.folder_url ?? null,
        analysis_summary: s?.analysis_summary ?? null,
        last_run_at: s?.last_run_at ?? null,
        media_assets: rows,
      };
    });
    return JSON.stringify({ results: byCode });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "checkPreuploadStatus failed");
    return JSON.stringify({ error: `pre-upload status lookup failed: ${msg}` });
  }
}
