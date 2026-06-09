import { getSupabase } from '../../integrations/supabase.js';
import { env } from '../../env.js';
import { logger } from '../../utils/logger.js';

/**
 * Dataset / pixel health audit (master-plan B9, feasibility verified live
 * against the PL pixel 2026-06-09).
 *
 * Answers, per client: is automatic advanced matching on (and with which
 * fields), is the dataset flagged restricted (health & wellness class), are
 * the core funnel events actually firing, are BOTH the browser pixel and the
 * Conversions API alive, and which customer-info match keys flow on each
 * event (the EMQ inputs). The official 0–10 EMQ score needs a per-dataset
 * Events Manager token (Dataset Quality API) — until that's collected during
 * onboarding, the match-keys breakdown is the EMQ proxy.
 */

const META_API_VERSION = 'v21.0';
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

/** Clients living in the Growth Squad BM need the GS token (AOT token lost access ~end May 2026). */
const GROWTHSQUAD_CLIENTS = new Set(['LA', 'LA2', 'TL']);

const CORE_ECOM_EVENTS = ['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase'];
/** Match keys that drive EMQ the most. */
const STRONG_MATCH_KEYS = new Set(['em', 'ph', 'email', 'phone']);

interface PixelConfig {
  id: string;
  name: string;
  last_fired_time?: string;
  is_unavailable?: boolean;
  enable_automatic_matching?: boolean;
  automatic_matching_fields?: string[];
  data_use_setting?: string;
  is_restricted_use?: boolean;
  first_party_cookie_status?: string;
}

function tokenFor(clientCode: string): string | undefined {
  const e = process.env;
  if (GROWTHSQUAD_CLIENTS.has(clientCode.toUpperCase()) && e.META_ACCESS_TOKEN_GROWTHSQUAD) {
    return e.META_ACCESS_TOKEN_GROWTHSQUAD;
  }
  return env.META_ACCESS_TOKEN;
}

async function graphGet(path: string, params: Record<string, string>, token: string): Promise<Record<string, unknown>> {
  const url = new URL(`${META_BASE_URL}/${path}`);
  url.searchParams.set('access_token', token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(60_000) });
  const body = (await resp.json()) as Record<string, unknown>;
  if (!resp.ok) {
    const fbError = body.error as Record<string, unknown> | undefined;
    throw new Error(`Facebook API error on ${path}: ${String(fbError?.message ?? resp.status)}`);
  }
  return body;
}

/** Sum stats buckets: [{start_time, data:[{value,count,event?}]}] → flat totals. */
function sumStats(
  body: Record<string, unknown>,
): { byValue: Record<string, number>; byEventValue: Record<string, Record<string, number>> } {
  const byValue: Record<string, number> = {};
  const byEventValue: Record<string, Record<string, number>> = {};
  for (const bucket of (body.data as Array<Record<string, unknown>> | undefined) ?? []) {
    for (const row of (bucket.data as Array<Record<string, unknown>> | undefined) ?? []) {
      const value = String(row.value);
      const count = Number(row.count) || 0;
      byValue[value] = (byValue[value] ?? 0) + count;
      if (row.event) {
        const event = String(row.event);
        byEventValue[event] = byEventValue[event] ?? {};
        byEventValue[event]![value] = (byEventValue[event]![value] ?? 0) + count;
      }
    }
  }
  return { byValue, byEventValue };
}

export async function auditDatasetHealth(params: { clientCode: string }): Promise<string> {
  try {
    const clientCode = params.clientCode.toUpperCase();
    const supabase = getSupabase();
    const { data: client, error } = await supabase
      .from('clients')
      .select('code, name, ad_account_id')
      .ilike('code', clientCode)
      .single();
    if (error) {
      return JSON.stringify({ error: `Client lookup failed for '${params.clientCode}': ${error.message}` });
    }
    if (!client?.ad_account_id) {
      return JSON.stringify({ error: `Client '${params.clientCode}' has no ad_account_id configured` });
    }
    const token = tokenFor(clientCode);
    if (!token) return JSON.stringify({ error: 'No Meta access token configured for this client' });

    // 1. Discover the account's pixels + their configuration in one call.
    const pixelsBody = await graphGet(`${client.ad_account_id as string}/adspixels`, {
      fields:
        'name,last_fired_time,is_unavailable,enable_automatic_matching,automatic_matching_fields,data_use_setting,is_restricted_use,first_party_cookie_status',
    }, token);
    const pixels = ((pixelsBody.data as PixelConfig[] | undefined) ?? []).slice(0, 3);
    if (pixels.length === 0) {
      return JSON.stringify({ error: `No pixels found on ${client.ad_account_id as string}` });
    }

    const results = [];
    for (const px of pixels) {
      // 2. Event volumes, source split, and match keys (stats cover ~the last day, hourly buckets).
      const [events, sources, matchKeys] = await Promise.all([
        graphGet(`${px.id}/stats`, { aggregation: 'event' }, token).then(sumStats),
        graphGet(`${px.id}/stats`, { aggregation: 'event_source' }, token).then(sumStats),
        graphGet(`${px.id}/stats`, { aggregation: 'match_keys' }, token).then(sumStats),
      ]);

      const server = sources.byValue.SERVER ?? 0;
      const browser = sources.byValue.BROWSER ?? 0;
      const total = server + browser;

      const hoursSinceFired = px.last_fired_time
        ? Math.round((Date.now() - new Date(px.last_fired_time).getTime()) / 3_600_000)
        : null;

      // Match keys on the conversion event that matters most.
      const purchaseKeys = matchKeys.byEventValue.Purchase ?? {};
      const purchaseHasStrongKey = Object.keys(purchaseKeys).some((k) => STRONG_MATCH_KEYS.has(k));

      const warnings: string[] = [];
      if (px.is_unavailable) warnings.push('Pixel is marked UNAVAILABLE.');
      if (hoursSinceFired !== null && hoursSinceFired > 24) {
        warnings.push(`Pixel has not fired in ${hoursSinceFired}h.`);
      }
      if (!px.enable_automatic_matching) {
        warnings.push('Automatic advanced matching is OFF — easy EMQ win, turn it on in Events Manager.');
      }
      if (px.is_restricted_use) {
        warnings.push(
          'Dataset is flagged RESTRICTED USE (health/wellness-class data restriction) — standard events and/or parameters may be dropped. Check Events Manager → Manage data source categories.',
        );
      }
      if (px.first_party_cookie_status && px.first_party_cookie_status !== 'first_party_cookie_enabled') {
        warnings.push(`First-party cookies: ${px.first_party_cookie_status}.`);
      }
      if (total > 0 && server === 0) {
        warnings.push('NO server (Conversions API) events — only browser pixel. CAPI is down or never set up; iOS/adblock traffic is being lost.');
      }
      if (total > 0 && browser === 0) {
        warnings.push('NO browser pixel events — only server. The on-site pixel may be broken (or this is a deliberate server-only setup).');
      }
      const missingCore = CORE_ECOM_EVENTS.filter((e) => (events.byValue[e] ?? 0) === 0);
      if (missingCore.length > 0 && Object.keys(events.byValue).length > 0) {
        warnings.push(`Core funnel events NOT seen in the last day: ${missingCore.join(', ')}.`);
      }
      if ((events.byValue.Purchase ?? 0) > 0 && !purchaseHasStrongKey) {
        warnings.push(
          'Purchase events carry NO email/phone match keys — match quality is capped. Send hashed em/ph via CAPI or advanced matching.',
        );
      }

      results.push({
        pixel_id: px.id,
        pixel_name: px.name,
        config: {
          automatic_advanced_matching: !!px.enable_automatic_matching,
          matching_fields: px.automatic_matching_fields ?? [],
          data_use_setting: px.data_use_setting,
          restricted_use_flag: !!px.is_restricted_use,
          first_party_cookies: px.first_party_cookie_status,
          last_fired: px.last_fired_time,
          hours_since_last_fire: hoursSinceFired,
        },
        events_last_day: events.byValue,
        source_split_last_day: {
          server_capi: server,
          browser_pixel: browser,
          server_share: total > 0 ? Math.round((server / total) * 100) / 100 : null,
        },
        match_keys_on_purchase: purchaseKeys,
        warnings,
      });
    }

    return JSON.stringify({
      client: { code: client.code, name: client.name, ad_account_id: client.ad_account_id },
      note:
        'Stats cover roughly the last 24h (hourly buckets). Official 0-10 EMQ score requires the Dataset Quality API per-dataset token (Events Manager) — match_keys above are the EMQ inputs and serve as the proxy.',
      pixels: results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg, clientCode: params.clientCode }, 'auditDatasetHealth failed');
    return JSON.stringify({ error: msg });
  }
}
