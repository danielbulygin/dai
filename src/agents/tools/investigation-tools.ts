import { lookup as dnsLookup } from 'node:dns/promises';
import { getTokenForClient, normalizeAdAccountId, type MetaTokenResolution } from '../../integrations/meta-token.js';
import { graphGet } from '../../integrations/meta-graph.js';
import {
  downloadMedia, geminiKey, geminiGenerateText,
  geminiUploadFile, geminiWaitActive, geminiDeleteFile,
} from '../../integrations/gemini.js';
import { env } from '../../env.js';
import { logger } from '../../utils/logger.js';

/**
 * Investigation tools — the READ-ONLY open-ended surface.
 *
 * The gap these close (project_ada_web_capability_gap.md, 2026-08-21): Ada is a
 * fixed-tool agent over curated data, while the value in a terminal session came
 * from open-ended investigation over RAW surfaces — ~15 Graph edges, `issues_info`
 * cracking a 22-ad mystery, looking at the actual pixels of a catalog image, and
 * reading the repo. None of that has a bespoke tool, and one tool per edge does
 * not scale.
 *
 * Three capabilities, each read-only BY CONSTRUCTION rather than by convention:
 *  1. meta_graph_get — any Graph node/edge this client owns. Always HTTP GET;
 *     the ?method=post override is impossible; the account is pinned to what the
 *     resolved token is actually granted.
 *  2. look_at_media — fetch arbitrary bytes and LOOK at them with Gemini, behind
 *     an SSRF guard that re-checks every redirect hop.
 *  3. read_repo_file / grep_repo — the droplet's repo reader (thin HTTP).
 *
 * House style: every failure is RETURNED as {"error": ...} JSON, never thrown.
 */

// ---------------------------------------------------------------------------
// meta_graph_get — arbitrary Graph READS, tenant-pinned
// ---------------------------------------------------------------------------

/** One read's response ceiling. Past this the model gets told to narrow it. */
const GRAPH_RESPONSE_CAP_BYTES = 1_500_000;

/**
 * Params that would change the REQUEST rather than describe it. `method=post`
 * is Graph's HTTP-verb override — allowing it would turn this read tool into a
 * write tool through a query string, which is exactly the failure mode this
 * design has to make impossible rather than unlikely.
 */
const DENIED_GRAPH_PARAMS = new Set(['access_token', 'method', 'appsecret_proof']);
const GRAPH_PATH_RE = /^[A-Za-z0-9_\-./]+$/;
const GRAPH_PARAM_KEY_RE = /^[A-Za-z0-9_.[\]]+$/;

/** Ownership-probe memo, per process. Key `<clientCode>:<nodeId>`. */
const ownershipCache = new Map<string, string | null>();

export function validateGraphPath(raw: string): { path: string } | { error: string } {
  const path = String(raw ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!path) {
    return { error: 'path is required — e.g. "act_1234567890/activities" or "120250000000/issues_info".' };
  }
  if (path.includes('..')) {
    return { error: `Refused: path '${path}' contains '..'.` };
  }
  if (!GRAPH_PATH_RE.test(path)) {
    return {
      error:
        `Refused: path '${path}' has characters outside [A-Za-z0-9_-./]. ` +
        'Put query arguments in `params`, not in the path.',
    };
  }
  return { path };
}

export function validateGraphParams(
  raw: Record<string, unknown> | undefined,
): { params: Record<string, string> } | { error: string } {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (DENIED_GRAPH_PARAMS.has(key.toLowerCase())) {
      return {
        error:
          `Refused: param '${key}' is not allowed. This tool is read-only by construction — ` +
          'the token is resolved from the client connection and the HTTP verb is always GET.',
      };
    }
    if (!GRAPH_PARAM_KEY_RE.test(key)) {
      return { error: `Refused: param name '${key}' has characters outside [A-Za-z0-9_.[]].` };
    }
    if (value === undefined || value === null) continue;
    params[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return { params };
}

export type LeadingNode =
  | { kind: 'account'; accountId: string }
  | { kind: 'numeric'; nodeId: string }
  | { kind: 'other'; segment: string };

/** Classify the first path segment — that is what decides tenant pinning. */
export function leadingNode(path: string): LeadingNode {
  const segment = path.split('/')[0] ?? '';
  if (/^act_\d+$/.test(segment)) return { kind: 'account', accountId: segment };
  if (/^\d+$/.test(segment)) return { kind: 'numeric', nodeId: segment };
  return { kind: 'other', segment };
}

/**
 * The accounts this token may legitimately be pointed at: everything the
 * connection granted, or — on the legacy env branch, where the token is
 * agency-wide — only the account on the client's own `clients` row.
 */
export function allowedAccounts(resolved: MetaTokenResolution): string[] {
  const granted = resolved.grantedAdAccountIds?.length
    ? resolved.grantedAdAccountIds
    : [resolved.adAccountId];
  return [...new Set(granted.map(normalizeAdAccountId).filter(Boolean))];
}

/**
 * Ask the node which ad account owns it. Returns null when the answer is
 * genuinely unavailable (node type has no `account_id`, or the probe failed) —
 * the caller then proceeds and labels the result "unverified" rather than
 * blocking a legitimate read on a node type Graph won't describe.
 */
async function probeNodeAccount(
  clientCode: string,
  nodeId: string,
  token: string,
): Promise<string | null> {
  const key = `${clientCode}:${nodeId}`;
  const cached = ownershipCache.get(key);
  if (cached !== undefined) return cached;

  let owner: string | null = null;
  try {
    const probe = await graphGet(nodeId, { fields: 'account_id' }, token, {
      paginate: false,
      timeoutMs: 15_000,
      maxBytes: 64 * 1024,
    });
    const raw = probe.node?.account_id;
    if (typeof raw === 'string' || typeof raw === 'number') {
      owner = normalizeAdAccountId(String(raw));
    }
  } catch (err) {
    logger.warn({ err, nodeId }, 'meta_graph_get ownership probe failed');
  }
  ownershipCache.set(key, owner);
  return owner;
}

export async function metaGraphGet(args: {
  clientCode: string;
  path: string;
  params?: Record<string, unknown>;
}): Promise<string> {
  try {
    const pathCheck = validateGraphPath(args.path);
    if ('error' in pathCheck) return JSON.stringify({ error: pathCheck.error });
    const paramCheck = validateGraphParams(args.params);
    if ('error' in paramCheck) return JSON.stringify({ error: paramCheck.error });

    const clientCode = String(args.clientCode ?? '').trim();
    if (!clientCode) return JSON.stringify({ error: 'clientCode is required.' });

    const resolved = await getTokenForClient({ clientCode });
    if (!resolved) {
      return JSON.stringify({
        error:
          `No usable Meta access for '${clientCode}'. The customer's connection may have expired, ` +
          'or the account is not connected.',
      });
    }

    const allowed = allowedAccounts(resolved);
    if (allowed.length === 0) {
      return JSON.stringify({
        error: `No ad account is associated with '${clientCode}', so no read can be scoped to it.`,
      });
    }

    const head = leadingNode(pathCheck.path);
    let ownership: 'verified' | 'unverified' = 'verified';

    if (head.kind === 'account') {
      if (!allowed.includes(head.accountId)) {
        return JSON.stringify({
          error:
            `Denied: ${head.accountId} is not an ad account '${clientCode}' has access to ` +
            `(allowed: ${allowed.join(', ')}). This tool cannot read another tenant's account.`,
        });
      }
    } else if (head.kind === 'other') {
      // Anything that is neither act_<id> nor a bare object id cannot be pinned
      // to this tenant — `me/adaccounts`, `search`, `debug_token` would all read
      // the AGENCY's surface through an agency env token. Fail closed.
      return JSON.stringify({
        error:
          `Denied: '${head.segment}' is not a client-owned node. Start the path with the client's ` +
          'ad account (act_<id>/…) or a specific object id (<id>/…) so the read can be scoped to this tenant.',
      });
    } else {
      const owner = await probeNodeAccount(clientCode, head.nodeId, resolved.token);
      if (owner && !allowed.includes(owner)) {
        return JSON.stringify({
          error:
            `Denied: node ${head.nodeId} belongs to ${owner}, which '${clientCode}' does not have ` +
            `access to (allowed: ${allowed.join(', ')}).`,
        });
      }
      if (!owner) ownership = 'unverified';
    }

    const result = await graphGet(pathCheck.path, paramCheck.params, resolved.token, {
      maxBytes: GRAPH_RESPONSE_CAP_BYTES,
    });
    if (result.error) return JSON.stringify({ error: result.error });

    const out: Record<string, unknown> = {
      path: pathCheck.path,
      ad_account_scope: allowed,
      ownership,
    };
    if (result.data) {
      out.row_count = result.data.length;
      if (result.truncated) out.truncated = true;
      out.data = result.data;
    } else {
      out.node = result.node ?? {};
    }
    return JSON.stringify(out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg, path: args.path }, 'metaGraphGet failed');
    return JSON.stringify({ error: msg });
  }
}

// ---------------------------------------------------------------------------
// look_at_media — fetch arbitrary bytes and LOOK at them
// ---------------------------------------------------------------------------

const IMAGE_CAP_BYTES = 6 * 1024 * 1024;
const VIDEO_CAP_BYTES = 48 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 5;
const LOOK_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36';

export const DEFAULT_LOOK_QUESTION =
  'Describe this ad/creative asset precisely: transcribe ALL visible text verbatim ' +
  '(including prices, badges, discount claims), name brands/logos, and describe the layout.';

/**
 * A Drive "view" link serves an HTML viewer, not the file. Rewrite it to the
 * direct-download form so the model gets pixels instead of markup — the
 * commonest paste shape in Slack and briefs.
 */
export function rewriteDriveUrl(url: string): string {
  const m = /^https?:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/.exec(url);
  if (!m) return url;
  return `https://drive.google.com/uc?export=download&id=${m[1]}`;
}

/** Private / reserved ranges an outbound fetch must never reach. */
export function isBlockedAddress(address: string): boolean {
  const addr = address.trim().toLowerCase();
  if (!addr) return true;

  // IPv4-mapped IPv6 (::ffff:10.0.0.1) — judge the embedded v4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return isBlockedAddress(mapped[1]!);

  if (addr.includes(':')) {
    if (addr === '::1' || addr === '::') return true;
    const head = addr.split(':')[0] ?? '';
    // fc00::/7 (unique-local), fe80::/10 (link-local).
    if (/^f[cd][0-9a-f]{0,2}$/.test(head)) return true;
    if (/^fe[89ab][0-9a-f]?$/.test(head)) return true;
    return false;
  }

  const parts = addr.split('.');
  if (parts.length !== 4) return true;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 127) return true;               // this-network, loopback
  if (a === 10) return true;                            // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16/12
  if (a === 192 && b === 168) return true;              // 192.168/16
  if (a === 169 && b === 254) return true;              // 169.254/16 link-local (cloud metadata)
  if (a === 100 && b >= 64 && b <= 127) return true;    // 100.64/10 CGNAT
  if (a >= 224) return true;                            // multicast + reserved
  return false;
}

/** Resolve a hostname and refuse it if ANY answer lands in a blocked range. */
async function assertPublicHost(hostname: string): Promise<string | null> {
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dnsLookup(hostname, { all: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Refused: could not resolve host '${hostname}' (${msg}).`;
  }
  if (!addresses?.length) return `Refused: host '${hostname}' resolved to no addresses.`;
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      return `Refused: host '${hostname}' resolves to ${address}, a private/reserved address. This tool only fetches public URLs.`;
    }
  }
  return null;
}

/**
 * Walk redirects OURSELVES, revalidating the host at every hop, and return the
 * final URL. downloadMedia follows redirects blindly, so an open redirect on a
 * public host would otherwise land on 169.254.169.254 with the guard already
 * satisfied. The real download then runs with redirect:'error' — a late
 * redirect fails closed instead of escaping the checks.
 */
async function resolvePublicUrl(startUrl: string): Promise<{ url: string } | { error: string }> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return { error: `Refused: '${current}' is not a valid URL.` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: `Refused: protocol '${parsed.protocol}' is not allowed — http/https only.` };
    }
    const hostError = await assertPublicHost(parsed.hostname);
    if (hostError) return { error: hostError };

    let resp: Response;
    try {
      resp = await fetch(current, {
        redirect: 'manual',
        headers: { 'user-agent': LOOK_UA },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Could not reach ${current}: ${msg}` };
    }
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      await resp.body?.cancel().catch(() => undefined);
      if (!location) return { error: `Redirect from ${current} had no Location header.` };
      current = new URL(location, current).toString();
      continue;
    }
    await resp.body?.cancel().catch(() => undefined);
    if (!resp.ok) return { error: `Fetch failed: ${resp.status} for ${current}` };
    return { url: current };
  }
  return { error: `Refused: more than ${MAX_REDIRECT_HOPS} redirects from ${startUrl}.` };
}

export async function lookAtMedia(args: { url: string; question?: string }): Promise<string> {
  try {
    const raw = String(args.url ?? '').trim();
    if (!raw) return JSON.stringify({ error: 'url is required.' });

    const key = geminiKey();
    if (!key) {
      return JSON.stringify({
        error:
          'GEMINI_API_KEY is not set in this environment, so I cannot look at media. ' +
          'Set it in the dai env (droplet /root/.env or the service EnvironmentFile) and retry.',
      });
    }

    const target = rewriteDriveUrl(raw);
    const resolvedUrl = await resolvePublicUrl(target);
    if ('error' in resolvedUrl) return JSON.stringify({ error: resolvedUrl.error });

    let media: { bytes: Buffer; mime: string };
    try {
      media = await downloadMedia(resolvedUrl.url, VIDEO_CAP_BYTES, { redirect: 'error' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Download failed: ${msg}` });
    }

    const question = String(args.question ?? '').trim() || DEFAULT_LOOK_QUESTION;
    const bytes = media.bytes.byteLength;
    let answer: string;

    if (media.mime.startsWith('image/')) {
      if (bytes > IMAGE_CAP_BYTES) {
        return JSON.stringify({
          error: `Image is ${bytes} bytes, over the ${IMAGE_CAP_BYTES}-byte inline cap. Ask for a smaller rendition.`,
        });
      }
      answer = await geminiGenerateText(key, [
        { inline_data: { mime_type: media.mime, data: media.bytes.toString('base64') } },
        { text: question },
      ]);
    } else if (media.mime.startsWith('video/')) {
      const file = await geminiUploadFile(key, media.bytes, media.mime);
      try {
        await geminiWaitActive(key, file.name);
        answer = await geminiGenerateText(key, [
          { file_data: { file_uri: file.uri, mime_type: media.mime } },
          { text: question },
        ]);
      } finally {
        void geminiDeleteFile(key, file.name);
      }
    } else {
      return JSON.stringify({
        error:
          `Fetched content_type '${media.mime}' (${bytes} bytes) is neither image/* nor video/*, so there is ` +
          'nothing to look at. A Google Drive link often returns text/html here — the file may be too large ' +
          'for direct download, or not shared publicly.',
      });
    }

    return JSON.stringify({
      url: resolvedUrl.url,
      content_type: media.mime,
      bytes,
      answer,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg, url: args.url }, 'lookAtMedia failed');
    return JSON.stringify({ error: msg });
  }
}

// ---------------------------------------------------------------------------
// read_repo_file / grep_repo — thin HTTP to the droplet's repo reader
// ---------------------------------------------------------------------------
// Same shape as ad-launch-tools.ts: env.DROPLET_URL + X-API-Key, FastAPI
// `detail` unwrap, self-describing error before any network call when the key
// is missing. 30s timeouts — these are file reads, not media jobs.

const DROPLET_TIMEOUT_MS = 30_000;

function getDropletUrl(): string {
  return env.DROPLET_URL || 'http://139.59.144.194:8080';
}

async function repoRequest<T = unknown>(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<{ data?: T; error?: string }> {
  const apiKey = (env as unknown as { DROPLET_API_KEY?: string }).DROPLET_API_KEY || '';
  if (!apiKey) {
    return {
      error:
        'DROPLET_API_KEY not set in DAI env. Set it to match API_SECRET on the BMAD droplet ' +
        '(/root/.env). Required by /api/ada/* endpoints.',
    };
  }

  const url = `${getDropletUrl()}${endpoint}`;
  logger.debug({ url }, 'Ada repo droplet request');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DROPLET_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 404) {
      return {
        error:
          `The droplet endpoint ${endpoint} returned 404 — it is not deployed yet. ` +
          'Repo reads are unavailable until the droplet ships /api/ada/repo-read and /api/ada/repo-grep.',
      };
    }
    if (!response.ok) {
      const detail = (data as Record<string, unknown>).detail ?? JSON.stringify(data);
      logger.error({ status: response.status, detail }, 'Ada repo droplet error');
      return { error: `Droplet error (${response.status}): ${detail}` };
    }
    return { data: data as T };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'Ada repo droplet request failed');
    return { error: `Failed to reach droplet: ${msg}` };
  }
}

export async function readRepoFile(args: { path: string }): Promise<string> {
  const path = String(args.path ?? '').trim();
  if (!path) return JSON.stringify({ error: 'path is required — e.g. "pma/global/meta-ads-api-gotchas.md".' });
  const result = await repoRequest('/api/ada/repo-read', { path });
  if (result.error) return JSON.stringify({ error: result.error });
  return JSON.stringify(result.data ?? {});
}

export async function grepRepo(args: {
  pattern: string;
  pathPrefix?: string;
  maxResults?: number;
}): Promise<string> {
  const pattern = String(args.pattern ?? '').trim();
  if (!pattern) return JSON.stringify({ error: 'pattern is required.' });
  const result = await repoRequest('/api/ada/repo-grep', {
    pattern,
    path_prefix: args.pathPrefix ?? null,
    max_results: args.maxResults ?? 100,
  });
  if (result.error) return JSON.stringify({ error: result.error });
  return JSON.stringify(result.data ?? {});
}
