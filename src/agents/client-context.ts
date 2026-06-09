import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { searchMethodology } from './tools/methodology-tools.js';

// ---------------------------------------------------------------------------
// Client-context injection for INTERNAL Ada runs.
//
// agents/ada/clients/<CODE>.md files hold per-client intelligence (KPIs,
// creative direction, working style, lessons). Client-scoped Ada loads them
// via buildClientOverlay(), but internal Ada in #ada never did — she answered
// "how's BFM doing?" without ever seeing BFM.md. This module detects which
// clients a conversation is about and returns their context files as extras.
// ---------------------------------------------------------------------------

const CLIENTS_DIR = join(process.cwd(), 'agents', 'ada', 'clients');

/** Common client names/aliases → client code. Codes themselves match directly. */
const NAME_ALIASES: Record<string, string> = {
  laori: 'LA',
  teethlovers: 'TL',
  'press london': 'PL',
  press: 'PL',
  'brain.fm': 'BFM',
  brainfm: 'BFM',
  sweetspot: 'SS',
  'sweet spot': 'SS',
  audibene: 'AB',
  forpeople: 'FP',
  'for people': 'FP',
  'four people': 'FP',
  ninepine: 'NP',
  'nine pine': 'NP',
  slumber: 'SLB',
  comis: 'COM',
  noso: 'NOSO',
  'jv academy': 'JVA',
  'john viola': 'JVA',
  meow: 'MEOW',
};

let knownCodes: Set<string> | null = null;

function getKnownCodes(): Set<string> {
  if (knownCodes) return knownCodes;
  try {
    knownCodes = new Set(
      readdirSync(CLIENTS_DIR)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.replace(/\.md$/, '').toUpperCase()),
    );
  } catch {
    knownCodes = new Set();
  }
  return knownCodes;
}

/**
 * Detect client codes referenced in conversation text. Matches bare codes as
 * standalone uppercase tokens ("BFM", "the LA account"), asset-id prefixes
 * ("FPLx4099" → FPL), and common client names ("laori", "press london").
 * Only returns codes that actually have a context file.
 */
export function detectClientCodes(texts: string[], maxCodes = 2): string[] {
  const codes = getKnownCodes();
  if (codes.size === 0) return [];

  const found = new Map<string, number>(); // code → hit count
  const bump = (code: string) => {
    if (codes.has(code)) found.set(code, (found.get(code) ?? 0) + 1);
  };

  for (const text of texts) {
    if (!text) continue;
    // Bare uppercase codes as standalone tokens (won't match "BM" inside "BMAD")
    for (const m of text.matchAll(/\b([A-Z]{2,5})\b/g)) {
      bump(m[1]!);
    }
    // Asset-id prefixes like FPLx4099 / STSPx3938
    for (const m of text.matchAll(/\b([A-Z]{2,5})x\d{3,5}\b/gi)) {
      bump(m[1]!.toUpperCase());
    }
    // Name aliases (case-insensitive)
    const lower = text.toLowerCase();
    for (const [alias, code] of Object.entries(NAME_ALIASES)) {
      if (lower.includes(alias)) bump(code);
    }
  }

  // Most-mentioned first, capped — two clients of context is plenty per turn.
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCodes)
    .map(([code]) => code);
}

/** methodology_knowledge.account_code uses lowercase account names, not client codes. */
const METHODOLOGY_ACCOUNT_BY_CODE: Record<string, string> = {
  AB: 'audibene',
  ADBN: 'audibene',
  BFM: 'brainfm',
  PL: 'press_london',
  LA: 'laori',
  TL: 'teethlovers',
  JVA: 'jva',
  NP: 'ninepine',
  COM: 'comis',
  NOSO: 'noso',
  SLB: 'slumber',
  FP: 'forpeople',
  SS: 'sweetspot',
};

/**
 * Pull the top account-specific methodology items (rules, insights, real
 * decisions extracted from Nina & Daniel's calls) for a detected client and
 * format them as a system-prompt extra. The corpus has 7,000+ items but
 * nothing pushed the relevant ones into analyses — Ada only saw them if she
 * happened to call search_methodology herself.
 */
export async function loadMethodologyExtra(
  code: string,
  limit = 8,
): Promise<{ name: string; content: string } | null> {
  const account = METHODOLOGY_ACCOUNT_BY_CODE[code];
  if (!account) return null;
  try {
    const raw = await searchMethodology({ accountCode: account, limit });
    const items = JSON.parse(raw) as Array<{ type?: string; title?: string }> | { error: string };
    if (!Array.isArray(items) || items.length === 0) return null;
    const lines = items
      .filter((i) => i.title)
      .map((i) => `- [${i.type ?? 'insight'}] ${i.title}`)
      .join('\n');
    if (!lines) return null;
    return {
      name: `methodology:${code}`,
      content:
        `## Extracted Methodology — ${code} (${account})\n` +
        `(Account-specific rules/insights/decisions extracted from real team calls. ` +
        `Use search_methodology for detail or topic-specific lookups.)\n\n${lines}`,
    };
  } catch (err) {
    logger.warn({ err, code }, 'Methodology retrieval pre-step failed');
    return null;
  }
}

/** Load the client context files for the given codes as system-prompt extras. */
export function loadClientContextExtras(
  codes: string[],
): { name: string; content: string }[] {
  const extras: { name: string; content: string }[] = [];
  for (const code of codes) {
    const path = join(CLIENTS_DIR, `${code}.md`);
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, 'utf-8').trim();
      if (content) {
        extras.push({
          name: `client-context:${code}`,
          content: `## Client Intelligence — ${code}\n(Internal context file for this client. Ground your analysis in it.)\n\n${content}`,
        });
      }
    } catch (err) {
      logger.warn({ err, code }, 'Failed to load client context file');
    }
  }
  return extras;
}
