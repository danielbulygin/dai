/**
 * Centralized client domain registry.
 *
 * Maps email domains → client code, display name, and optional Slack channel.
 * Used by the meeting pipeline classifier, Notion webhook routing, and
 * anywhere else we need domain→client resolution.
 */

export interface ClientDomainEntry {
  clientCode: string;
  clientName: string;
  slackChannel?: string;
}

const DOMAIN_REGISTRY: Record<string, ClientDomainEntry> = {
  // Active clients
  'audibene.de': { clientCode: 'AB', clientName: 'Audibene', slackChannel: 'C0A5GPDKXEK' },
  'teethlovers.de': { clientCode: 'TL', clientName: 'Teethlovers', slackChannel: 'C09LUB9CZC2' },
  'ninepine.co': { clientCode: 'NP', clientName: 'Ninepine' },
  'laori.com': { clientCode: 'LA', clientName: 'Laori' },
  'press.london': { clientCode: 'PL', clientName: 'Press London' },
  'brain.fm': { clientCode: 'BFM', clientName: 'Brain.fm' },
  'slumber.com': { clientCode: 'SLB', clientName: 'Slumber' },
  'urvi.de': { clientCode: 'URV', clientName: 'URVI' },
  'jvacademy.de': { clientCode: 'JVA', clientName: 'JV Academy' },
  'strayz.de': { clientCode: 'MEOW', clientName: 'Strayz' },
  'noso.co': { clientCode: 'NOSO', clientName: "Nothing's Something" },
  'freeletics.com': { clientCode: 'FP', clientName: 'Freeletics' },
  'comis.de': { clientCode: 'COM', clientName: 'COMIS' },
  'sunshinesmile.de': { clientCode: 'SS', clientName: 'Sunshine Smile' },
};

const INTERNAL_DOMAINS = new Set([
  'adsontap.io',
]);

const INTERNAL_EMAILS = new Set([
  'daniel.bulygin@gmail.com',
  'danielbulygin@gmail.com',
]);

export function getClientForDomain(domain: string): ClientDomainEntry | undefined {
  return DOMAIN_REGISTRY[domain.toLowerCase()];
}

export function getClientCodeForEmail(email: string): string | undefined {
  const domain = email.trim().split('@')[1]?.toLowerCase();
  if (!domain) return undefined;
  return DOMAIN_REGISTRY[domain]?.clientCode;
}

export function isInternalEmail(email: string): boolean {
  const lower = email.trim().toLowerCase();
  if (INTERNAL_EMAILS.has(lower)) return true;
  const domain = lower.split('@')[1];
  return domain ? INTERNAL_DOMAINS.has(domain) : false;
}

export function getSlackChannelForDomain(domain: string): string | undefined {
  return DOMAIN_REGISTRY[domain.toLowerCase()]?.slackChannel;
}

/**
 * Scan an array of participant emails and return the most likely client code.
 * Returns undefined if all participants are internal or unknown.
 */
export function resolveClientFromParticipants(
  emails: string[],
): { clientCode: string; clientName: string; confidence: number } | undefined {
  const counts = new Map<string, { entry: ClientDomainEntry; count: number }>();

  for (const email of emails) {
    if (isInternalEmail(email)) continue;
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) continue;
    const entry = DOMAIN_REGISTRY[domain];
    if (!entry) continue;

    const existing = counts.get(entry.clientCode);
    if (existing) {
      existing.count++;
    } else {
      counts.set(entry.clientCode, { entry, count: 1 });
    }
  }

  if (counts.size === 0) return undefined;

  // Pick the client with the most participant emails
  let best: { entry: ClientDomainEntry; count: number } | undefined;
  for (const val of counts.values()) {
    if (!best || val.count > best.count) best = val;
  }

  return best
    ? { clientCode: best.entry.clientCode, clientName: best.entry.clientName, confidence: 0.95 }
    : undefined;
}
