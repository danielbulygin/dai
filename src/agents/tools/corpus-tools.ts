import {
  storeSearch, storeRead, clientScopeFor, allClientScopes, MISSING_PASSWORD_ERROR,
} from '../../memory-store/store-client.js';
import { logger } from '../../utils/logger.js';

/**
 * Corpus tools — Ada's search over the AOT Memory store (the unified agent
 * memory: org-tier cross-client truths, per-client learnings, Ada's own
 * backfilled learnings, the constitution).
 *
 * Why these exist (the bottleneck the 2026-08-23 investigation evals proved):
 * for 2 of 3 failed cases, the correct answer already sat in the corpus —
 * Meta error 2643152's diagnosis route, the DPA baked-price mechanism — and
 * Ada had NO way to retrieve any of it at runtime. Tools gave her reach;
 * this gives her the agency's accumulated knowledge.
 *
 * Scope rules (enforced by RLS in the store, not by this file): a client
 * scope in the request only ADDS that client's tier; org/system/agent-ada are
 * always readable. Internal profiles only — like the investigation surface,
 * this is NOT in the client-facing Tinkers profile.
 *
 * House style: every failure is RETURNED as {"error": ...} JSON, never thrown.
 */

export async function searchCorpus(args: {
  query: string;
  clientCode?: string;
  limit?: number;
}): Promise<string> {
  try {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return JSON.stringify({
        error: 'query is required — a full natural question works well (the search is hybrid keyword+semantic).',
      });
    }
    // Internal Ada is cross-client by design (like her other client tools):
    // a specific clientCode narrows relevance, but all client tiers stay readable.
    const scopes = allClientScopes();
    const scope = clientScopeFor(args.clientCode);
    const hits = await storeSearch({ query, clientScopes: scopes, limit: args.limit ?? 12 });
    return JSON.stringify({
      query,
      client_scope: scope ?? null,
      hit_count: hits.length,
      hits: hits.map((h) => ({
        path: h.path,
        title: h.title,
        snippet: h.snippet,
      })),
      note: hits.length
        ? 'Snippets only — call read_corpus_memory with a path to read the full memory before relying on it.'
        : 'No hits. Try different terms (error codes and exact phrases work well), or grep_repo for repo docs.',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === MISSING_PASSWORD_ERROR) return JSON.stringify({ error: msg });
    logger.error({ error: msg, query: args.query }, 'searchCorpus failed');
    return JSON.stringify({ error: msg });
  }
}

export async function readCorpusMemory(args: { path: string }): Promise<string> {
  try {
    const path = String(args.path ?? '').trim();
    if (!path) {
      return JSON.stringify({ error: 'path is required — e.g. "org/reference_meta_ads_api_gotchas.md" (from search_corpus).' });
    }
    const memory = await storeRead({ path, clientScopes: allClientScopes() });
    if (!memory) {
      return JSON.stringify({
        error: `No readable memory at '${path}'. Paths come from search_corpus results; agent/terminal/* is not readable by Ada (by design — promoted knowledge lives under org/).`,
      });
    }
    return JSON.stringify({
      address: memory.address,
      title: memory.title,
      version: memory.version,
      content: memory.content,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === MISSING_PASSWORD_ERROR) return JSON.stringify({ error: msg });
    logger.error({ error: msg, path: args.path }, 'readCorpusMemory failed');
    return JSON.stringify({ error: msg });
  }
}
