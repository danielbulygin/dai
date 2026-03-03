/**
 * Safe methodology search tool for client-facing Ada.
 *
 * Wraps the existing searchMethodology function with:
 * 1. Account scoping — only returns global + client's own entries
 * 2. Body stripping — removes evidence/detail JSONB from results
 * 3. Client name redaction — regex-replaces other client names/codes
 */

import { getSupabase } from '../integrations/supabase.js';
import { searchMethodology } from '../agents/tools/methodology-tools.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Client name cache for redaction
// ---------------------------------------------------------------------------

interface ClientNameEntry {
  code: string;
  name: string;
}

let clientNamesCache: ClientNameEntry[] | null = null;
let clientNamesCacheExpiry = 0;
const CLIENT_NAMES_TTL_MS = 30 * 60 * 1000; // 30 min

async function getClientNames(): Promise<ClientNameEntry[]> {
  const now = Date.now();
  if (clientNamesCache && clientNamesCacheExpiry > now) {
    return clientNamesCache;
  }

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('clients')
      .select('code, name')
      .eq('is_active', true);

    if (error) {
      logger.error({ error }, 'Failed to load client names for redaction');
      return clientNamesCache ?? [];
    }

    clientNamesCache = (data ?? []) as ClientNameEntry[];
    clientNamesCacheExpiry = now + CLIENT_NAMES_TTL_MS;
    return clientNamesCache;
  } catch (err) {
    logger.error({ err }, 'getClientNames failed');
    return clientNamesCache ?? [];
  }
}

/**
 * Build a regex that matches any client name or code except the allowed one.
 * Returns null if there's nothing to redact.
 */
function buildRedactionRegex(
  clients: ClientNameEntry[],
  allowedClientCode: string,
): RegExp | null {
  const patterns: string[] = [];

  for (const client of clients) {
    if (client.code === allowedClientCode) continue;

    // Escape regex special chars
    const escapedCode = client.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedName = client.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    patterns.push(escapedCode);
    if (escapedName !== escapedCode) {
      patterns.push(escapedName);
    }
  }

  if (patterns.length === 0) return null;
  return new RegExp(`\\b(${patterns.join('|')})\\b`, 'gi');
}

function redactText(text: string, regex: RegExp | null): string {
  if (!regex || !text) return text;
  return text.replace(regex, '[redacted]');
}

// ---------------------------------------------------------------------------
// Safe methodology search
// ---------------------------------------------------------------------------

interface SafeMethodologyResult {
  id: string;
  type: string;
  title: string;
  account_code: string | null;
  category: string | null;
  confidence: string;
  rank: number;
}

/**
 * Search methodology knowledge, scoped and sanitized for a client.
 * - Only returns global entries + entries for this client
 * - Strips body JSONB (evidence/details)
 * - Redacts other client names from titles
 */
export async function searchMethodologySafe(params: {
  query?: string;
  type?: string;
  category?: string;
  limit?: number;
  clientCode: string;
}): Promise<string> {
  try {
    // Search with account filter = clientCode (returns global + client-specific)
    const rawJson = await searchMethodology({
      query: params.query,
      type: params.type,
      accountCode: params.clientCode,
      category: params.category,
      limit: params.limit,
    });

    const raw = JSON.parse(rawJson) as Array<Record<string, unknown>>;

    if (!Array.isArray(raw)) {
      return rawJson; // Error response, pass through
    }

    // Build redaction regex
    const clients = await getClientNames();
    const redactionRegex = buildRedactionRegex(clients, params.clientCode);

    // Strip body and redact client names
    const safe: SafeMethodologyResult[] = raw.map((row) => ({
      id: row.id as string,
      type: row.type as string,
      title: redactText(row.title as string, redactionRegex),
      account_code: row.account_code as string | null,
      category: row.category as string | null,
      confidence: row.confidence as string,
      rank: row.rank as number,
    }));

    return JSON.stringify(safe);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg, clientCode: params.clientCode }, 'searchMethodologySafe failed');
    return JSON.stringify({ error: msg });
  }
}
