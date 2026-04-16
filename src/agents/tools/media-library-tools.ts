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
      headers: { "Content-Type": "application/json" },
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
    image_id?: string;
    url?: string;
    status: string;
    error?: string;
    renamed_in_drive: boolean;
  }>;
  summary: {
    total: number;
    successful: number;
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
 */
export async function uploadToMediaLibrary(params: {
  drive_url: string;
  client_code: string;
}): Promise<string> {
  const { data, error } = await dropletRequest(
    "/api/media-library/upload",
    {
      drive_url: params.drive_url,
      client_code: params.client_code,
      poll_for_ready: true,
    },
    900_000, // 15 min timeout (large video uploads)
  );

  if (error) {
    return JSON.stringify({ error });
  }

  return JSON.stringify(data);
}
