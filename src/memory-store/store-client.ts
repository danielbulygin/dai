import { createHash } from 'node:crypto';
import pg from 'pg';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';

/**
 * AOT Memory store client — Ada's READ leg of the unified memory system.
 *
 * CANONICAL SOURCE: bmad repo, `pma/tools/memory-api/src/{db,api,embeddings}.ts` —
 * this is a trimmed copy (search + read only, Ada principal only), following the
 * `_constitution.md` copy-with-canonical-pointer pattern the AOT Memory plan
 * recommends for dai ("copy the client module into dai — no new service, no HTTP
 * auth story"; PROGRESS.md "Resume here" item 2). If the store contract changes,
 * change it THERE first; this file follows.
 *
 * Access model (enforced by Postgres RLS via the mem_api role, NOT by this code):
 * the principal is set transaction-locally as app.* GUCs; Ada (role=agent,
 * agent=ada) can read the system boundary, the internal org tier, her own
 * agent/ada scratchpad (the 1,362 backfilled learnings), and any client tier
 * granted in read_scopes. agent/terminal (the terminal sessions' scratchpad)
 * stays invisible BY DESIGN — cross-agent knowledge travels via org promotion.
 * A wrong or missing principal reads NOTHING (fail-closed, audit A1).
 */

const EMBEDDING_MODEL = 'gemini-embedding-001@768';
const API_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIMS = 768;
const MAX_EMBED_CHARS = 6000;
const RRF_K = 60;

// The 17 canonical client scopes in the store, keyed by every code/alias dai or
// ad-set naming uses. Canonical source: backfill-learnings.ts CLIENT_ALIASES.
// 'pl'/'press' added here: Press London's ad-set codes are PLx and no other
// client collides with them.
const CLIENT_SCOPE_ALIASES: Record<string, string[]> = {
  audibene: ['audibene', 'ab', 'adbn'],
  brainfm: ['brainfm', 'brain_fm', 'bfm'],
  'catch-and-keep': ['catch_keep', 'catch_and_keep', 'catch-and-keep'],
  faircado: ['faircado'],
  forpeople: ['forpeople', 'four_people', 'forpeoplewhocare', 'fpl'],
  getgoing: ['get_going', 'getgoing', 'gg'],
  'jv-academy': ['jva', 'jv-academy', 'jva_weekly', 'jva_toronto', 'jva_us_general'],
  laori: ['laori', 'la'],
  meow: ['meow'],
  ninepine: ['ninepine', 'np'],
  'press-london': ['press_london', 'press-london', 'press', 'pl'],
  slumber: ['slumber', 'slb'],
  strayz: ['strayz'],
  sweetspot: ['sweetspot', 'sweet_spot', 'ss', 'stsp'],
  teethlovers: ['teethlovers', 'tl'],
  urvi: ['urvi', 'urv'],
  'vi-lifestyle': ['vi_lifestyle', 'vi-lifestyle'],
};

const ALIAS_TO_SCOPE: Map<string, string> = new Map();
for (const [scope, aliases] of Object.entries(CLIENT_SCOPE_ALIASES)) {
  for (const alias of aliases) ALIAS_TO_SCOPE.set(alias.toLowerCase(), scope);
}

export function clientScopeFor(code: string | undefined | null): string | null {
  if (!code) return null;
  return ALIAS_TO_SCOPE.get(String(code).trim().toLowerCase()) ?? null;
}

export function allClientScopes(): string[] {
  return Object.keys(CLIENT_SCOPE_ALIASES);
}

export interface StoreSearchHit {
  address: string;
  path: string;
  title: string | null;
  snippet: string;
  score: number;
  version: number;
  /** First ~N chars of the memory body — only when search ran with contentHeadChars. */
  contentHead?: string;
}

export interface StoreMemory {
  address: string;
  path: string;
  title: string | null;
  content: string;
  version: number;
}

let pool: pg.Pool | null = null;

function getPool(): pg.Pool | null {
  const password = (env as unknown as Record<string, string | undefined>).AOT_MEMORY_DB_PASSWORD;
  if (!password) return null;
  if (!pool) {
    // Same connection contract as memory-api/src/db.ts: the dedicated mem_api
    // role (NOBYPASSRLS) through the Supabase session pooler — never a service key.
    pool = new pg.Pool({
      host: 'aws-1-eu-west-1.pooler.supabase.com',
      port: 5432,
      database: 'postgres',
      user: 'mem_api.bzhqvxknwvxhgpovrhlp',
      password,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
    });
  }
  return pool;
}

/** Test seam. */
export function _setPool(p: pg.Pool | null): void {
  pool = p;
}

export const MISSING_PASSWORD_ERROR =
  'AOT_MEMORY_DB_PASSWORD is not set in this environment, so the memory store is unreachable. ' +
  'Set it in the dai env (droplet /root/dai/.env) and restart.';

function geminiKey(): string | null {
  const e = env as unknown as Record<string, string | undefined>;
  return e.GOOGLE_GEMINI_API_KEY ?? e.GEMINI_API_KEY ?? null;
}

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/** Embed ONE query string; null on any failure (search degrades to FTS-only). */
async function embedQuery(query: string): Promise<number[] | null> {
  const key = geminiKey();
  if (!key) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${API_MODEL}:batchEmbedContents?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            model: `models/${API_MODEL}`,
            content: { parts: [{ text: query.slice(0, MAX_EMBED_CHARS) }] },
            taskType: 'RETRIEVAL_QUERY',
            outputDimensionality: EMBEDDING_DIMS,
          }],
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) throw new Error(`embedding API ${res.status}`);
    const body = (await res.json()) as { embeddings?: { values: number[] }[] };
    const values = body.embeddings?.[0]?.values;
    return values ? normalize(values) : null;
  } catch (err) {
    logger.warn({ err }, 'store search: semantic arm skipped');
    return null;
  }
}

function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

/**
 * Run `fn` inside a transaction with a principal set FIRST (the GUC invariant
 * from memory-api/src/api.ts — RLS does the enforcement, this only declares
 * who is asking). Scopes are canonical store scopes ('client:teethlovers').
 */
async function withPrincipal<T>(
  principal: { agent: string; readScopes: string[]; writeScopes: string[] },
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const p = getPool();
  if (!p) throw new Error(MISSING_PASSWORD_ERROR);
  const c = await p.connect();
  try {
    await c.query('begin');
    await c.query(
      `select set_config('search_path', 'public, extensions', true),
              set_config('app.boundary', 'internal', true),
              set_config('app.role',     'agent', true),
              set_config('app.agent',    $1, true),
              set_config('app.read_scopes',  $2, true),
              set_config('app.write_scopes', $3, true)`,
      [principal.agent, JSON.stringify(principal.readScopes), JSON.stringify(principal.writeScopes)],
    );
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (err) {
    await c.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** The READ principal: Ada, all client tiers readable, writes ALWAYS empty. */
async function withAdaPrincipal<T>(
  clientScopes: string[],
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withPrincipal(
    { agent: 'ada', readScopes: clientScopes.map((s) => `client:${s}`), writeScopes: [] },
    fn,
  );
}

/**
 * Hybrid search (FTS + embeddings, RRF merge) — a faithful trim of
 * memory-api api.ts search(). Rows Ada may not read are absent via RLS.
 */
export async function storeSearch(args: {
  query: string;
  clientScopes: string[];
  limit?: number;
  /** When set, each hit also carries the first N chars of the memory body. */
  contentHeadChars?: number;
}): Promise<StoreSearchHit[]> {
  const limit = args.limit ?? 12;
  const headChars = Math.max(0, Math.min(4000, args.contentHeadChars ?? 0));
  const queryVec = await embedQuery(args.query);

  return withAdaPrincipal(args.clientScopes, async (c) => {
    const fts = await c.query(
      `select boundary, path, title, version,
              ts_headline('english', content, q, 'MaxWords=35, MinWords=10') as snippet,
              left(content, $3) as content_head
         from memories, websearch_to_tsquery('english', $1) q
        where is_active and content_tsv @@ q
        order by ts_rank(content_tsv, q) desc, path
        limit $2`,
      [args.query, limit, headChars],
    );
    const vec = queryVec
      ? await c.query(
          `select m.boundary, m.path, m.title, m.version,
                  left(m.content, 300) as snippet,
                  left(m.content, $4) as content_head
             from memory_embeddings e
             join memories m on m.boundary = e.boundary and m.path = e.path and m.is_active
            where e.model = $1
            order by e.embedding <=> $2::vector
            limit $3`,
          [EMBEDDING_MODEL, toVectorLiteral(queryVec), limit, headChars],
        )
      : { rows: [] as Record<string, unknown>[] };

    const merged = new Map<string, { row: Record<string, unknown>; score: number }>();
    for (const [arm, rows] of [['fts', fts.rows], ['vec', vec.rows]] as const) {
      rows.forEach((row: Record<string, unknown>, i: number) => {
        const key = `${row.boundary}::${row.path}`;
        const entry = merged.get(key) ?? { row, score: 0 };
        entry.score += 1 / (RRF_K + i + 1);
        if (arm === 'fts') entry.row = row; // prefer the FTS headline snippet
        merged.set(key, entry);
      });
    }
    return [...merged.values()]
      .sort((a, b) => b.score - a.score || (String(a.row.path) < String(b.row.path) ? -1 : 1))
      .slice(0, limit)
      .map(({ row, score }) => ({
        address: `${row.boundary}::${row.path}`,
        path: String(row.path),
        title: (row.title as string | null) ?? null,
        snippet: String(row.snippet ?? ''),
        score,
        version: Number(row.version),
        ...(headChars > 0 ? { contentHead: String(row.content_head ?? '') } : {}),
      }));
  });
}

/** Read one memory's full content by store path (RLS decides visibility). */
export async function storeRead(args: {
  path: string;
  clientScopes: string[];
}): Promise<StoreMemory | null> {
  return withAdaPrincipal(args.clientScopes, async (c) => {
    // No boundary pin: RLS already limits reads to system + Ada's internal
    // slice, and paths are boundary-unique in practice (internal wins if not).
    const res = await c.query(
      `select boundary, path, title, content, version
         from memories
        where path = $1 and is_active
        order by (boundary = 'internal') desc
        limit 1`,
      [args.path],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      address: `${row.boundary}::${row.path}`,
      path: row.path,
      title: row.title ?? null,
      content: row.content,
      version: row.version,
    };
  });
}

// ---------------------------------------------------------------------------
// WRITE leg (Stage B dual-write, spec §7.1 / §8.2) — one narrow write:
// Ada's remember() mirrors each new learning into the store, using the EXACT
// path scheme and file shape of backfill-learnings.ts so live writes and the
// 3,548 backfilled rows form one reconcilable corpus. All other write paths
// stay closed (the read principal pins write_scopes to []).
// ---------------------------------------------------------------------------

/** Frontmatter key order — MUST match backfill-learnings.ts KNOWN_KEYS. */
const LEARNING_KEYS = [
  'id', 'agent_id', 'category', 'client_code', 'confidence', 'applied_count',
  'score', 'source_session_id', 'created_at', 'updated_at',
] as const;

export interface LearningRowForStore {
  id: string;
  agent_id: string;
  content: string;
  category?: string | null;
  client_code?: string | null;
  confidence?: number | null;
  source_session_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Same slug + tier routing as backfill-learnings.ts pathForRow. */
export function learningPath(row: LearningRowForStore): string {
  const slug = `learning-${row.id.toLowerCase().replace(/[^a-z0-9]+/g, '')}-${sha256Hex(row.id).slice(0, 6)}`;
  const scope = clientScopeFor(row.client_code ?? null);
  if (scope) return `client/${scope}/learnings/${slug}.md`;
  const agent = /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(row.agent_id) ? row.agent_id : 'unknown';
  return `agent/${agent}/learnings/${slug}.md`;
}

/** YAML-safe like the backfill: strings via JSON.stringify, numbers/bools/null bare. */
function yamlValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(String(v));
}

/** Same file shape as backfill-learnings.ts composeMemory (fields as frontmatter, claim as body). */
export function composeLearningMemory(row: LearningRowForStore): string {
  const excluded = new Set(['content', 'search_vector']);
  const extras = Object.keys(row)
    .filter((k) => !(LEARNING_KEYS as readonly string[]).includes(k) && !excluded.has(k))
    .sort();
  const lines = [...(LEARNING_KEYS as readonly string[]).filter((k) => k in row), ...extras]
    .map((k) => `${k}: ${yamlValue(row[k])}`);
  return `---\n${lines.join('\n')}\n---\n\n${row.content ?? ''}`;
}

function learningTitle(row: LearningRowForStore): string {
  const first = (row.content ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0)
    ?? `learning ${row.id}`;
  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}

/**
 * Mirror one learning into the store via mem_propose_write (the ONLY write
 * path — permission + CAS enforced in the database, audit A1/A2). The
 * principal is the writing agent itself with exactly the one write scope the
 * row routes to. Idempotent: an identical existing head is a clean no-op; a
 * different head is CAS-retried once against its sha.
 */
export async function storeWriteLearning(row: LearningRowForStore): Promise<{
  status: 'committed' | 'noop';
  path: string;
  version?: number;
}> {
  const path = learningPath(row);
  const tier = path.startsWith('client/') ? 'client' : 'agent';
  const scope = path.split('/')[1]!;
  const content = composeLearningMemory(row);
  const title = learningTitle(row);
  const writeScopes = tier === 'client' ? [`client:${scope}`] : [];

  return withPrincipal(
    { agent: row.agent_id, readScopes: writeScopes, writeScopes },
    async (c) => {
      const propose = async (base: string | null) => c.query(
        `select out_version, out_sha256, out_status
           from mem_propose_write($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          'internal', path, tier, scope, content, title, base,
          row.agent_id, row.source_session_id ?? 'dai-live', 'agent', 'agent',
          null, 'dai remember() dual-write (Stage B, spec §8.2)',
        ],
      );
      try {
        const res = await propose(null);
        return { status: 'committed' as const, path, version: Number(res.rows[0]?.out_version) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/conflict|already exists|duplicate/i.test(msg)) throw err;
        // Head exists (a retry, or the backfill got here first): identical
        // content is a no-op; different content is CAS-written over the head.
        const head = await c.query(
          `select content, content_sha256 from memories
            where boundary = 'internal' and path = $1 and is_active`,
          [path],
        );
        const headRow = head.rows[0];
        if (!headRow) throw err;
        if (headRow.content === content) return { status: 'noop' as const, path };
        const res = await propose(String(headRow.content_sha256));
        return { status: 'committed' as const, path, version: Number(res.rows[0]?.out_version) };
      }
    },
  );
}
