import { getSupabase } from './supabase.js';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';

/**
 * get_token_for_client() — the Meta access-token bridge.
 *
 * The load-bearing resolver for the Ada audit rail: it answers "what token +
 * ad account do I use to read this account live?" for BOTH
 *  - a self-serve / Tinkers connect (token in `meta_connections`, keyed by the
 *    auth user who connected), and
 *  - a legacy agency client (no connection row → env token, keyed by client code).
 *
 * Per the meta_connections migration contract (20260624000000): read
 * `meta_connections` FIRST, fall back to the env token for legacy clients.
 * The cold-path audit (unsynced accounts) rides the connection branch; the
 * synced accelerator path keeps using the env branch exactly as before.
 *
 * The token-SELECTION logic (which granted account, which env token) is pure
 * and unit-tested; only the connection lookup touches Supabase.
 */

export type MetaTokenSource = 'connection' | 'env';

export interface MetaTokenResolution {
  /** The Meta access token to sign Graph requests with. */
  token: string;
  /** The ad account to audit, normalised to `act_<id>`. */
  adAccountId: string;
  source: MetaTokenSource;
  /** readonly | write for a connection; 'legacy' for the env branch. */
  mode: 'readonly' | 'write' | 'legacy';
  connectionId?: string;
  clientId?: string | null;
  /** Every granted account on the connection (connection branch only). */
  grantedAdAccountIds?: string[];
}

export interface TokenLookup {
  /** Legacy agency client code (AB, GG, SS, LA, TL …). */
  clientCode?: string;
  /** Auth user who connected (self-serve / Tinkers lead). */
  userId?: string;
  /** Provisioned client row id. */
  clientId?: string;
  /**
   * Pin a specific granted account. If given and granted on the connection we
   * use it; otherwise we fall back to the first granted account (what the
   * Tinkers funnel showed the user — inferAccountSnapshot uses [0]).
   */
  adAccountId?: string;
}

/** Growth Squad's Business Manager holds LA/LA2/TL — a separate agency token. */
const GROWTHSQUAD = new Set(['LA', 'LA2', 'TL']);

/** Normalise a bare account id to the `act_<id>` form the Graph API expects. */
export function normalizeAdAccountId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith('act_') ? trimmed : `act_${trimmed}`;
}

/**
 * Pure account selection: prefer the pinned account when it's actually granted,
 * else the first granted account (funnel parity). Comparison is act_-insensitive.
 */
export function pickAdAccount(granted: string[], pinned?: string): string | null {
  const norm = granted.map(normalizeAdAccountId).filter(Boolean);
  if (norm.length === 0) return null;
  if (pinned) {
    const want = normalizeAdAccountId(pinned);
    const hit = norm.find((a) => a === want);
    if (hit) return hit;
  }
  return norm[0]!;
}

/**
 * Pure env-token selection for legacy clients — the same GROWTHSQUAD split the
 * audit engine has always used, in ONE place so the bridge and the engine can't
 * drift. Reads process.env for the Growth Squad token (not in the env schema).
 */
export function envTokenFor(clientCode: string): string | undefined {
  const code = clientCode.toUpperCase();
  const gs = process.env.META_ACCESS_TOKEN_GROWTHSQUAD;
  return GROWTHSQUAD.has(code) && gs ? gs : env.META_ACCESS_TOKEN;
}

interface ConnectionRow {
  id: string;
  client_id: string | null;
  access_token: string | null;
  ad_account_ids: string[] | null;
  mode: string | null;
  status: string | null;
}

/** Resolve the most-recent active connection for a user / client. */
async function findConnection(lookup: TokenLookup): Promise<ConnectionRow | null> {
  const sb = getSupabase();
  let q = sb
    .from('meta_connections')
    .select('id, client_id, access_token, ad_account_ids, mode, status')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1);

  if (lookup.userId) q = q.eq('user_id', lookup.userId);
  else if (lookup.clientId) q = q.eq('client_id', lookup.clientId);
  else if (lookup.clientCode) {
    const { data: client } = await sb
      .from('clients')
      .select('id')
      .ilike('code', lookup.clientCode)
      .maybeSingle();
    if (!client?.id) return null;
    q = q.eq('client_id', client.id as string);
  } else {
    return null;
  }

  const { data, error } = await q.maybeSingle();
  if (error) {
    logger.warn({ err: error.message, lookup: Object.keys(lookup) }, 'meta_connections lookup failed');
    return null;
  }
  return (data as ConnectionRow | null) ?? null;
}

/** Resolve a legacy client's ad account from the `clients` table. */
async function findClientAdAccount(clientCode: string): Promise<string | null> {
  const { data } = await getSupabase()
    .from('clients')
    .select('ad_account_id')
    .ilike('code', clientCode)
    .maybeSingle();
  const acct = data?.ad_account_id as string | null | undefined;
  return acct ? normalizeAdAccountId(acct) : null;
}

/**
 * Resolve a usable {token, adAccountId} for a client/connection, or null if
 * neither a live connection nor an env token can serve one.
 *
 * Order (migration contract): connection FIRST, env fallback for legacy clients.
 */
export async function getTokenForClient(lookup: TokenLookup): Promise<MetaTokenResolution | null> {
  // 1) Live OAuth connection (self-serve / Tinkers, or a connected agency client).
  const conn = await findConnection(lookup);
  if (conn?.access_token) {
    const acct = pickAdAccount(conn.ad_account_ids ?? [], lookup.adAccountId);
    if (acct) {
      return {
        token: conn.access_token,
        adAccountId: acct,
        source: 'connection',
        mode: conn.mode === 'write' ? 'write' : 'readonly',
        connectionId: conn.id,
        clientId: conn.client_id,
        grantedAdAccountIds: (conn.ad_account_ids ?? []).map(normalizeAdAccountId),
      };
    }
    logger.warn({ connectionId: conn.id }, 'connection has token but no granted ad account');
  }

  // 2) Legacy env token — only meaningful with a client code (env token is
  //    agency-wide; the account comes from the clients row).
  if (lookup.clientCode) {
    const token = envTokenFor(lookup.clientCode);
    const acct = lookup.adAccountId
      ? normalizeAdAccountId(lookup.adAccountId)
      : await findClientAdAccount(lookup.clientCode);
    if (token && acct) {
      return { token, adAccountId: acct, source: 'env', mode: 'legacy' };
    }
  }

  return null;
}
