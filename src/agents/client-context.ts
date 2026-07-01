import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { searchMethodology } from './tools/methodology-tools.js';
import { getClientTargets } from './tools/client-config-tools.js';
import { getLearnings, getTopLearnings, type Learning } from '../memory/learnings.js';
import { getSupabase } from '../integrations/supabase.js';

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

// ---------------------------------------------------------------------------
// Client knowledge injection (Ada 2.0 Phase B — the context layer).
//
// WHY: the JVA golden-case eval fail (2026-07-02) proved the web loop answers
// client questions from the GLOBAL top-5 learnings only — client-scoped
// learnings and KPI targets never reached the prompt, and audits injected zero
// client knowledge at all (progress doc §5 #12, #6). These helpers are the one
// shared source both chat prompt paths AND the audit engine pull from.
// Everything here is fail-soft: missing config/learnings degrade to null,
// never break a run.
// ---------------------------------------------------------------------------

/** Pure formatter (unit-testable): the targets/KPI section from a parsed config. */
export function formatClientTargetsSection(code: string, cfg: Record<string, unknown>): string | null {
  if (!cfg || cfg.error) return null;
  const compact = JSON.stringify(cfg, null, 1);
  return (
    `## Client Targets & KPI Config — ${code}\n` +
    `(Canonical per-client targets from client_configs. ANCHOR every judgment to these — ` +
    `"good"/"bad"/"below breakeven" only means something relative to THIS client's target and primary KPI. ` +
    `If a metric has no target here, say so rather than judging against a generic benchmark.)\n\n` +
    '```json\n' + compact + '\n```'
  );
}

/**
 * KPI targets + benchmarks for a detected client, as a system-prompt extra.
 * Source: client_configs via getClientTargets; falls back to the clients
 * table's conversion_goals when no config row exists.
 */
export async function loadClientTargetsExtra(
  code: string,
): Promise<{ name: string; content: string } | null> {
  try {
    const raw = await getClientTargets({ clientCode: code });
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const section = formatClientTargetsSection(code, cfg);
    if (section) return { name: `client-targets:${code}`, content: section };
    // Fallback: conversion goals from the clients row (thin but target-anchoring).
    const { data } = await getSupabase()
      .from('clients')
      .select('code, name, currency, conversion_goals')
      .ilike('code', code)
      .maybeSingle();
    if (!data?.conversion_goals) return null;
    return {
      name: `client-targets:${code}`,
      content:
        `## Client Targets — ${code}\n(No full KPI config; conversion goals from the clients table.)\n\n` +
        '```json\n' + JSON.stringify({ name: data.name, currency: data.currency, conversion_goals: data.conversion_goals }, null, 1) + '\n```',
    };
  } catch (err) {
    try { logger.warn({ err, code }, 'client targets extra failed (fail-soft)'); } catch { /* noop */ }
    return null;
  }
}

/** Pure formatter (unit-testable): the client-scoped learnings section. */
export function formatClientLearningsSection(
  code: string,
  learnings: Pick<Learning, 'content'>[],
): string | null {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const l of learnings) {
    const key = (l.content ?? '').toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${l.content}`);
    if (lines.length >= 10) break;
  }
  if (!lines.length) return null;
  return (
    `## Client Learnings — ${code}\n` +
    `(Saved learnings SPECIFIC to this client — newest first, so recent corrections supersede older patterns. ` +
    `These outrank generic priors: if a learning here contradicts what you'd otherwise assume, the learning wins.)\n\n` +
    lines.join('\n')
  );
}

/**
 * learnings.client_code is FREEFORM mixed-convention data — 'jva', 'brain_fm',
 * 'brainfm', 'bfm', 'press_london', 'la', 'teethlovers' all coexist (verified
 * on the live store 2026-07-02: 41 learnings under 'jva' were invisible to a
 * code-keyed query). Build the candidate set for a bmad code from the maps we
 * already maintain. Long-term fix = normalization at write time / the AOT
 * Memory migration; this makes reads correct today.
 */
export function learningClientCodeCandidates(code: string): string[] {
  const set = new Set<string>([code, code.toLowerCase()]);
  const meth = METHODOLOGY_ACCOUNT_BY_CODE[code];
  if (meth) set.add(meth);
  for (const [alias, c] of Object.entries(NAME_ALIASES)) {
    if (c === code) {
      set.add(alias.replace(/[.\s]+/g, '_'));
      set.add(alias.replace(/[.\s]+/g, ''));
    }
  }
  return [...set];
}

/**
 * Client-scoped learnings for a detected client: Ada's learnings tagged with
 * this client_code (newest first — a fresh correction must surface immediately,
 * unlike the score-ranked global top-5) merged with the client-agent's own top
 * learnings. This is the fix for the JVA golden-case gap.
 */
export async function loadClientLearningsExtra(
  code: string,
): Promise<{ name: string; content: string } | null> {
  try {
    const [scoped, agentTops] = await Promise.all([
      getLearnings('ada', undefined, 10, learningClientCodeCandidates(code)).catch(() => [] as Learning[]),
      getTopLearnings(`ada_client_${code}`, 5).catch(() => [] as Learning[]),
    ]);
    const section = formatClientLearningsSection(code, [...scoped, ...agentTops]);
    if (!section) return null;
    return { name: `client-learnings:${code}`, content: section };
  } catch (err) {
    try { logger.warn({ err, code }, 'client learnings extra failed (fail-soft)'); } catch { /* noop */ }
    return null;
  }
}

/**
 * The full per-client knowledge bundle for NON-chat consumers (the audit
 * engine): intelligence file + targets + client-scoped learnings as one
 * string. Chat paths inject the pieces individually as extras instead.
 */
export async function buildClientKnowledgeBundle(code: string, maxChars = 14_000): Promise<string> {
  const parts: string[] = [];
  const [targets, learnings] = await Promise.all([
    loadClientTargetsExtra(code),
    loadClientLearningsExtra(code),
  ]);
  if (targets) parts.push(targets.content);
  if (learnings) parts.push(learnings.content);
  const files = loadClientContextExtras([code]);
  for (const f of files) parts.push(f.content);
  const joined = parts.join('\n\n');
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n…(client context truncated)` : joined;
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
