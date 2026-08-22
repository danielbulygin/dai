import { env } from '../env.js';

/**
 * Minimal Gemini client + bounded media download (REST; no SDK in this repo).
 *
 * Extracted VERBATIM from src/audit/cold-creative.ts (2026-08-22) so a second
 * caller — the investigation tool `look_at_media` — can reuse the same vision
 * plumbing instead of growing a parallel copy. cold-creative.ts imports these
 * back and behaves exactly as before; the only additions are
 *  - `downloadMedia`'s optional `redirect` override (defaults to the old
 *    'follow', so nothing changes for the audit path), and
 *  - `geminiGenerateText` (plain-text sibling of geminiGenerateJson, no meter).
 *
 * Files API for video, inline base64 for images.
 */

// gemini-3-flash-preview is the bulk tier (NEVER older models; the deep tier
// would be gemini-3.1-pro-preview — gemini-3-pro-preview is retired/404).
export const GEMINI_MODEL = 'gemini-3-flash-preview';
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
// Conservative per-token estimates for the meter (flash-class pricing).
const GEMINI_IN_PER_M = 0.5;
const GEMINI_OUT_PER_M = 3.0;
const GEMINI_FLAT_FALLBACK_USD = 0.03;
export const GEMINI_COST_LABEL = 'gemini_creative';

/** Structural view of the orchestrator's CostMeter (class is module-private). */
export interface AuditCostMeter {
  spentUsd: number;
  readonly breakdown: Record<string, number>;
  add(label: string, usd: number): void;
  exhausted(): boolean;
}

export function geminiKey(): string | null {
  return env.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ?? null;
}

// ---------------------------------------------------------------------------
// Bounded media download
// ---------------------------------------------------------------------------

export async function downloadMedia(
  url: string,
  maxBytes: number,
  /**
   * Redirect policy. Defaults to 'follow' (the audit path's original
   * behaviour). SSRF-sensitive callers pass 'error' after they have validated
   * every hop themselves, so a late redirect fails closed instead of being
   * chased to an unvalidated host.
   */
  opts: { redirect?: 'follow' | 'error' | 'manual' } = {},
): Promise<{ bytes: Buffer; mime: string }> {
  const resp = await fetch(url, {
    redirect: opts.redirect ?? 'follow',
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
// Files API (video) + generateContent
// ---------------------------------------------------------------------------

export async function geminiUploadFile(key: string, bytes: Buffer, mime: string): Promise<{ uri: string; name: string }> {
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

export async function geminiWaitActive(key: string, name: string, timeoutMs = 90_000): Promise<void> {
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

export async function geminiDeleteFile(key: string, name: string): Promise<void> {
  try {
    await fetch(`${GEMINI_BASE}/v1beta/${name}?key=${key}`, { method: 'DELETE', signal: AbortSignal.timeout(15_000) });
  } catch {
    /* best effort — Files API auto-expires after 48h anyway */
  }
}

interface GeminiUsage { promptTokenCount?: number; candidatesTokenCount?: number }

interface GeminiCandidates {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: GeminiUsage;
}

export async function geminiGenerateJson<T>(
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
  const body = (await resp.json()) as GeminiCandidates;
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

/**
 * Plain-prose sibling of geminiGenerateJson — for free-text "look at this and
 * tell me what you see" reads where a schema would only get in the way. No
 * meter: the investigation surface is one-shot and human-triggered, unlike the
 * audit's batch loop which has to hold a $ cap.
 */
export async function geminiGenerateText(
  key: string,
  parts: unknown[],
  opts: { maxOutputTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
  const resp = await fetch(`${GEMINI_BASE}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.2, maxOutputTokens: opts.maxOutputTokens ?? 2000 },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`gemini generateContent failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const body = (await resp.json()) as GeminiCandidates;
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text.trim()) throw new Error('gemini returned no text');
  return text.trim();
}
