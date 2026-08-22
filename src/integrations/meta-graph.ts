import { logger } from '../utils/logger.js';

/**
 * graph_get() — the shared Meta Graph READ helper.
 *
 * Generalised out of meta-api-tools.ts's private `metaApiRequest` (2026-08-22)
 * so the open-ended investigation surface (`meta_graph_get`) and the bespoke
 * insights/creative tools sign requests the same way. What it keeps from the
 * original: the pinned v21.0 version, the 429 special case, the Facebook error
 * unwrap, and auto-pagination up to a row cap.
 *
 * What it adds, and why the original could not serve the investigation tool:
 *  - NODE responses. metaApiRequest assumed every response is an edge with a
 *    `data` array, so a single-object read (`<id>?fields=...`) came back as an
 *    empty list. Investigation reads are frequently node reads.
 *  - a byte ceiling. An unconstrained `fields=` on a large edge can return tens
 *    of MB; the caller gets a self-describing error instead of a blown context.
 *  - access_token is set LAST, so a caller-supplied `access_token` param can
 *    never displace the resolved one.
 *
 * Every failure is RETURNED, never thrown — same contract as the tools layer.
 */

export const META_API_VERSION = 'v21.0';
export const META_GRAPH_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

const DEFAULT_MAX_ROWS = 500;
const DEFAULT_TIMEOUT_MS = 60_000;
/** Generous default so existing callers behave exactly as before. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export interface GraphGetOptions {
  /** Stop collecting edge rows past this count. Default 500 (the old cap). */
  maxRows?: number;
  /** Per-request timeout. Default 60s (the old timeout). */
  timeoutMs?: number;
  /** Total response-byte ceiling across all pages. Default 8MB. */
  maxBytes?: number;
  /** Follow `paging.next`. Default true. */
  paginate?: boolean;
}

export interface GraphGetResult {
  /** Edge/list rows, auto-paged and row-capped. Set when the body had `data`. */
  data?: unknown[];
  /** Node body. Set when the response was a single object (no `data` array). */
  node?: Record<string, unknown>;
  error?: string;
  /** True when `maxRows` stopped pagination before Facebook ran out of pages. */
  truncated?: boolean;
  /** Bytes read across all pages (approximate — decoded response text). */
  bytes?: number;
}

type CappedRead =
  | { kind: 'ok'; status: number; ok: boolean; text: string; bytes: number }
  | { kind: 'oversize'; bytes: number }
  | { kind: 'failed'; message: string };

/**
 * One GET, read with a hard byte ceiling. Streams when the runtime gives us a
 * body reader; falls back to text() when it does not (mocked fetch in tests).
 */
async function fetchCapped(url: string, timeoutMs: number, maxBytes: number): Promise<CappedRead> {
  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { kind: 'failed', message: err instanceof Error ? err.message : String(err) };
  }

  const declared = Number(resp.headers?.get?.('content-length') ?? 0);
  if (declared > maxBytes) return { kind: 'oversize', bytes: declared };

  const reader = resp.body?.getReader?.();
  if (!reader) {
    const text = await resp.text();
    if (text.length > maxBytes) return { kind: 'oversize', bytes: text.length };
    return { kind: 'ok', status: resp.status, ok: resp.ok, text, bytes: text.length };
  }

  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { kind: 'oversize', bytes };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { kind: 'ok', status: resp.status, ok: resp.ok, text, bytes };
}

function oversizeError(maxBytes: number): string {
  return (
    `Meta Graph response exceeded the ${Math.round(maxBytes / 1024)}KB cap for one read. ` +
    'Narrow the request — ask for fewer `fields`, add a smaller `limit`, or read one child at a time — and try again.'
  );
}

function parseBody(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * GET any Graph node or edge with a resolved token.
 *
 * `path` is everything after the version segment — `act_123/activities`,
 * `120250000000/issues_info`, `<product_set_id>`. Query params go in `params`
 * (unencoded values; they are URL-encoded here).
 */
export async function graphGet(
  path: string,
  params: Record<string, string>,
  token: string,
  opts: GraphGetOptions = {},
): Promise<GraphGetResult> {
  if (!token) return { error: 'No Meta access token available for this client.' };

  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const paginate = opts.paginate ?? true;

  const url = new URL(`${META_GRAPH_BASE}/${path.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  // LAST — a caller-supplied access_token must never win over the resolved one.
  url.searchParams.set('access_token', token);

  logger.debug({ path, params: Object.keys(params) }, 'Meta Graph request');

  const first = await fetchCapped(url.toString(), timeoutMs, maxBytes);
  if (first.kind === 'failed') return { error: `Facebook API request failed: ${first.message}` };
  if (first.kind === 'oversize') return { error: oversizeError(maxBytes) };
  if (first.status === 429) return { error: 'Rate limited by Facebook API. Wait a moment and retry.' };

  const body = parseBody(first.text);
  if (!body) {
    return { error: `Facebook API returned a non-JSON response (status ${first.status}).` };
  }

  if (!first.ok) {
    const fbError = body.error as Record<string, unknown> | undefined;
    const msg = fbError?.message ?? JSON.stringify(body);
    logger.error({ status: first.status, error: msg }, 'Meta Graph error');
    return { error: `Facebook API error: ${msg}` };
  }

  let bytes = first.bytes;

  // Node read — no `data` array means a single object, hand it back whole.
  if (!Array.isArray(body.data)) {
    return { node: body, bytes };
  }

  let allData = body.data as unknown[];
  let paging = body.paging as Record<string, unknown> | undefined;
  let truncated = false;

  while (paginate && paging?.next && allData.length < maxRows) {
    const next = await fetchCapped(paging.next as string, timeoutMs, maxBytes - bytes);
    if (next.kind === 'oversize') {
      truncated = true;
      break;
    }
    if (next.kind === 'failed' || !next.ok) break;
    bytes += next.bytes;
    const nextBody = parseBody(next.text);
    const nextData = nextBody?.data as unknown[] | undefined;
    if (!nextData?.length) break;
    allData = allData.concat(nextData);
    paging = nextBody?.paging as Record<string, unknown> | undefined;
  }

  if (paging?.next && allData.length >= maxRows) truncated = true;

  return { data: allData, bytes, ...(truncated ? { truncated: true } : {}) };
}
