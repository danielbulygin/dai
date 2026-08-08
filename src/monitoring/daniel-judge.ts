/**
 * The simulated-Dan judge (board card 86) — grades a report against the
 * standard distilled from Daniel's own calls before it posts.
 *
 * Canonical rubric with receipts: tinkers
 * docs/factory/day-2026-08-07/daniel-rubric.md (raw per-call extraction in
 * daniel-patterns.json beside it). House pattern: deterministic LINTER for
 * the mechanical rules + LLM JUDGE for the graded read. The judge encodes
 * Daniel's questions and standards, not his live judgment: it flags, it
 * never rubber-stamps, and it must NEVER block a brief — a judge failure is
 * logged and the brief posts anyway.
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';

const MODEL = 'claude-sonnet-4-6';

export interface JudgeVerdict {
  scores: {
    why_bottoms_out: number;
    localization: number;
    action_ownership: number;
    verification: number;
    client_money_lens: number;
    proactivity: number;
  };
  overall: number; // 0-10
  weakest_line: string;
  daniel_question: string; // the one question Daniel would ask that the report can't answer
  improvement: string; // one concrete change for tomorrow
  linter: string[]; // deterministic findings, merged in by the caller
}

// ---------------------------------------------------------------------------
// Linter — the mechanical rules Daniel has stated, checkable without a model.
// ---------------------------------------------------------------------------

const CURRENCY_RE = /[$£€]|\bSEK\b|\bkr\b/;

export function lintBrief(text: string): string[] {
  const findings: string[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('• ')) {
      // A mover bullet must be followed by a why-clause.
      const next = lines[i + 1] ?? '';
      if (!next.includes('↳ why:')) {
        findings.push(`mover without a why: "${line.trim().slice(0, 70)}…"`);
      }
      // Percentages never travel alone (Daniel, 2026-08-07).
      if (/\d+(\.\d+)?%/.test(line) && !CURRENCY_RE.test(line)) {
        findings.push(`percentage without a currency amount: "${line.trim().slice(0, 70)}…"`);
      }
    }
    // Relative day-words in mover/why lines (multi-day surfaces name their days).
    if ((line.includes('↳ why:') || line.trimStart().startsWith('• ')) && /\byesterday\b|\btoday\b/i.test(line)) {
      findings.push(`relative day-word in a multi-day line: "${line.trim().slice(0, 70)}…"`);
    }
  }

  if (!/verified against the warehouse sync|could not verify/i.test(text)) {
    findings.push('no verification/honesty line anywhere in the report');
  }
  return findings;
}

// ---------------------------------------------------------------------------
// The judge
// ---------------------------------------------------------------------------

const RUBRIC = `You are the "simulated Dan" — a judge trained on how Daniel (agency owner) interrogates performance reports, distilled from his own calls. Grade the report below against his six standards. Be demanding: Daniel's stated complaint about early reports was "nice, but I'm missing the why and something actionable."

The six axes (score each 0-10):
1. why_bottoms_out — every movement carries a cause that ends in an INPUT (audience, creative, budget/bid, structure, tracking, world), never just another metric ("CPM went up" is a result, not a cause). Sudden moves have a DATED trigger. Honest "cause unclear + what was checked" earns credit; an unexplained number does not.
2. localization — breaks are pinned to a funnel stage, segment/breakdown, category, or named object; never "the account overall". Correlated moves read as one signature. Every money line labeled.
3. action_ownership — every negative finding carries a proposed action; kill/hold calls reference persistence ("second day", "last 14"); the reader never ends asking "so what do we do?". "No action needed, here's why" counts as an action.
4. verification — surprising numbers are cross-checked or explicitly flagged unverified; measurement problems separated from behavior; structural constraints (caps, floors) checked before interpreting spend.
5. client_money_lens — currency amounts lead; percentages only as meaning; blended metrics never justify decisions; framed against the client's own targets/bands.
6. proactivity — leading indicators (frequency creep, spend-share shift, launch watches) flagged before they become problems; baselines are defined periods; wins interrogated like losses ("Nice. Why?").
7. plain_speech (folds into your overall score, weigh it heavily) — every line reads like a colleague talking across the desk. Violations: "X, not Y" aphorisms used as style ("the lever is consolidation, not budget"), metaphors about the analysis ("the account changed shape", "tracks the budget", "carries the story"), taglines about the report itself. The test: would a person say this sentence out loud? If a line sounds like marketing copy, quote it in weakest_line and say how a person would phrase it.

Also produce:
- weakest_line: quote the single weakest line in the report (verbatim, trimmed).
- daniel_question: THE one question Daniel would ask after reading this that the report cannot answer. Make it specific to this report's content, not generic.
- improvement: one concrete change that would most raise tomorrow's score.

Return STRICT JSON only:
{"scores":{"why_bottoms_out":n,"localization":n,"action_ownership":n,"verification":n,"client_money_lens":n,"proactivity":n},"overall":n,"weakest_line":"...","daniel_question":"...","improvement":"..."}
overall is your holistic 0-10, not an average.`;

export async function judgeBrief(briefText: string): Promise<JudgeVerdict> {
  const linter = lintBrief(briefText);
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    temperature: 0,
    system: [{ type: 'text', text: RUBRIC, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `Linter findings (deterministic, already confirmed): ${
          linter.length ? linter.join(' | ') : 'none'
        }\n\nThe report:\n\n${briefText}`,
      },
    ],
  });
  const raw = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '');
  const parsed = JSON.parse(raw) as Omit<JudgeVerdict, 'linter'>;
  return { ...parsed, linter };
}

/** The one-line self-check appended to a brief that scores under the bar. */
export function selfCheckLine(v: JudgeVerdict, bar = 7): string | null {
  if (v.overall >= bar && v.linter.length === 0) return null;
  const bits = [`⚖️ _self-check: ${v.overall}/10 on the Daniel bar`];
  if (v.linter.length) bits.push(`${v.linter.length} rule violation${v.linter.length === 1 ? '' : 's'}`);
  bits.push(`the question this brief can't answer: ${v.daniel_question}_`);
  return bits.join(' · ');
}

/** Judge, but never let judging break the thing being judged. */
export async function judgeSafely(briefText: string): Promise<JudgeVerdict | null> {
  try {
    return await judgeBrief(briefText);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'daniel-judge failed — brief posts unjudged');
    return null;
  }
}
