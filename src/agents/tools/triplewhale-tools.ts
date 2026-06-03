/**
 * Triple Whale summary metrics (blended profitability data Meta doesn't have).
 *
 * Hits the public TW API (`/api/v2/summary-page/get-data`, x-api-key auth) with
 * Dan's account-level key. The key is account-scoped, NOT shop-scoped: it works
 * for every shop Dan's TW login can access (verified: Laori + Press London),
 * anything else returns "Access Denied".
 *
 * Gotcha: TW identifies shops by the *.myshopify.com domain, never the
 * storefront domain (laoridrinks.com → Access Denied).
 *
 * Gotcha #2 (verified 2026-06-03): the API's `values.previous` /
 * `charts.previous` are UNRELIABLE — TW's previous-period computation hits an
 * incomplete cache (observed: only day 1 of 7 populated, €5.5k reported for a
 * week that direct-queries to €70.4k; the same call returned correct data
 * earlier the same day). `current` values are consistent and chain correctly
 * across windows, so we fetch the preceding window with a SECOND direct query
 * and report ITS `current` as `previous`.
 */

import { env } from '../../env.js';
import { logger } from '../../utils/logger.js';

/** Client code → Triple Whale shopDomain (must be the .myshopify.com domain). */
const TW_SHOP_DOMAINS: Record<string, string> = {
  LA: 'noadrinks.myshopify.com', // Laori (legacy "NOA drinks" shop name)
  PL: 'press-london-2018.myshopify.com', // Press London
};

/**
 * The curated metric set returned by default. The summary endpoint returns
 * ~700 metrics; this is the profitability core the team actually reports on.
 * `totalNetProfit` is THE weekly profit number Laori's client asks for.
 */
const DEFAULT_METRIC_IDS = [
  'totalSales', // Order Revenue
  'newCustomerSales', // New Customer Revenue
  'grossProfit', // Net Sales - COGS - Shipping - Handling - Taxes - Gateways
  'totalNetProfit', // Order Revenue - Returns - Expenses - Blended Ad Spend
  'totalProductCosts', // COGS
  'totalCustomSpends', // Custom Expenses (deducted from Net Profit)
  'blendedAds', // Blended Ad Spend (all channels + custom ad-spend expenses)
  'totalRoas', // Blended ROAS
  'newCustomersRoas', // New Customer ROAS
  'poas', // Profit on Ad Spend (Gross Profit / Total Ad Spend)
  'totalCpa', // Blended CPA
  'fb_ads_spend', // Facebook Ads spend
  'ga_adCost', // Google Ads spend
];

interface TwMetric {
  metricId: string;
  title: string;
  tip?: string;
  type?: string;
  values?: { current?: number; previous?: number };
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function shiftIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** One summary-page call; returns the metrics array or throws with detail. */
async function fetchSummaryWindow(
  apiKey: string,
  shopDomain: string,
  start: string,
  end: string,
): Promise<TwMetric[]> {
  const res = await fetch('https://api.triplewhale.com/api/v2/summary-page/get-data', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ shopDomain, period: { start, end } }),
  });
  const text = await res.text();
  if (!res.ok || text.startsWith('Access Denied')) {
    throw new Error(`Triple Whale request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (JSON.parse(text) as { metrics?: TwMetric[] }).metrics ?? [];
}

export async function getTriplewhaleSummary(params: {
  clientCode: string;
  days?: number;
  startDate?: string;
  endDate?: string;
  metricIds?: string[];
}): Promise<string> {
  try {
    const apiKey = env.TRIPLEWHALE_API_KEY;
    if (!apiKey) {
      return JSON.stringify({
        error: 'TRIPLEWHALE_API_KEY is not configured on this deployment',
      });
    }

    const code = params.clientCode.toUpperCase();
    const shopDomain = TW_SHOP_DOMAINS[code];
    if (!shopDomain) {
      return JSON.stringify({
        error: `No Triple Whale shop mapped for client '${code}'`,
        available_clients: Object.keys(TW_SHOP_DOMAINS),
        hint: 'Add the client\'s .myshopify.com domain to TW_SHOP_DOMAINS in triplewhale-tools.ts (and confirm Dan\'s TW account has access to that shop).',
      });
    }

    // Default window: the last `days` full days ending yesterday (today is
    // always partial in TW and would understate revenue/profit).
    const days = params.days && params.days > 0 ? params.days : 7;
    const end = params.endDate ?? isoDaysAgo(1);
    const start = params.startDate ?? isoDaysAgo(days);

    // The preceding window of equal length, fetched as its own direct query —
    // never trust the API's `values.previous` (see gotcha #2 in the header).
    const windowLen = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
    const prevStart = shiftIso(start, -windowLen);
    const prevEnd = shiftIso(start, -1);

    const [all, prevAll] = await Promise.all([
      fetchSummaryWindow(apiKey, shopDomain, start, end),
      fetchSummaryWindow(apiKey, shopDomain, prevStart, prevEnd).catch((err) => {
        logger.warn({ clientCode: code, err: String(err) }, 'Triple Whale previous-window fetch failed — returning current only');
        return [] as TwMetric[];
      }),
    ]);

    const wanted = new Set([...DEFAULT_METRIC_IDS, ...(params.metricIds ?? [])]);
    const round = (v: unknown) => (typeof v === 'number' ? Math.round(v * 100) / 100 : null);

    const prevByid = new Map<string, TwMetric>();
    for (const m of prevAll) if (!prevByid.has(m.metricId)) prevByid.set(m.metricId, m);

    const metrics: Record<string, { title: string; current: number | null; previous: number | null }> = {};
    for (const m of all) {
      if (!wanted.has(m.metricId) || metrics[m.metricId]) continue;
      metrics[m.metricId] = {
        title: m.title,
        current: round(m.values?.current),
        previous: round(prevByid.get(m.metricId)?.values?.current),
      };
    }

    const missing = [...wanted].filter((id) => !metrics[id]);
    logger.debug({ clientCode: code, shopDomain, start, end, returned: Object.keys(metrics).length }, 'Triple Whale summary loaded');
    return JSON.stringify({
      client_code: code,
      shop_domain: shopDomain,
      period: { start, end },
      previous_period: { start: prevStart, end: prevEnd },
      previous_period_note: '`previous` = the immediately preceding window of the same length, fetched as its own query (period-over-period deltas come free).',
      net_profit_definition: 'totalNetProfit = Order Revenue - Returns - Expenses (COGS, Shipping, Handling, Payment Gateways, Taxes, Custom Expenses) - Blended Ad Spend',
      metrics,
      ...(missing.length ? { metric_ids_not_found: missing } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg, clientCode: params.clientCode }, 'getTriplewhaleSummary failed');
    return JSON.stringify({
      error: msg,
      ...(msg.includes('Access Denied')
        ? { hint: 'Access Denied usually means the API key\'s TW account lost access to this shop, or the shopDomain is not the .myshopify.com domain.' }
        : {}),
    });
  }
}
