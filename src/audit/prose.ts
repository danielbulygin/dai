/**
 * Deterministic prose scrub — the last gate before audit text is written back.
 *
 * Two house rules, both non-negotiable and both cheap to enforce by machine:
 *  1. No em-dashes in anything a customer reads (Dan, 2026-08-09). Periods,
 *     commas and colons instead. Numeric ranges keep their en dash (40–60%).
 *  2. No sentence that says nothing. "Your account is clean", "spend broadly
 *     tracking return", "nothing to force here" all pass the section's schema
 *     while citing no number, which is exactly the filler the section brief
 *     bans. A banned sentence fails the section into ONE rewrite retry
 *     (the caller owns that, it needs the model) and is STRIPPED if it survives.
 *
 * Everything here is pure: text in, text out, findings as data. No logging, no
 * throwing — a scrub that can fail the audit is worse than the em-dash.
 */

/** Phrases that assert a verdict without a number behind it. */
const BANNED: Array<{ label: string; re: RegExp }> = [
  { label: 'your account is clean', re: /\byour account is clean\b/i },
  { label: 'spend broadly tracking return', re: /\bspend\s+(?:is\s+)?broadly\s+tracking\s+return\b/i },
  { label: 'nothing to force here', re: /\bnothing to force here\b/i },
];

/** An em dash anywhere, or an en dash used as punctuation (spaced on both sides). */
const PUNCT_DASH = /\s*—\s*|\s+–\s+/;
const PUNCT_DASH_G = new RegExp(PUNCT_DASH.source, 'g');

/** Sentence boundary: terminator followed by whitespace (never inside "18.59"). */
const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

const upperFirst = (s: string): string =>
  /^[a-z]/.test(s) ? s[0]!.toUpperCase() + s.slice(1) : s;

function dedashSentence(sentence: string): string {
  const segments = sentence.split(PUNCT_DASH_G).map((p) => p.trim()).filter((p) => p.length > 0);
  if (segments.length < 2) return sentence;
  // Two dashes fence an aside, which is what commas are for. A single dash
  // joins two clauses, and a full stop is the plain way to write that.
  if (segments.length > 2) return segments.join(', ');
  return `${segments[0]!.replace(/[,;:]$/, '')}. ${upperFirst(segments[1]!)}`;
}

/** Rewrite em-dash punctuation into house punctuation. Idempotent. */
export function dedash(text: string): string {
  if (!text || !PUNCT_DASH.test(text)) return text;
  return text
    .split(SENTENCE_SPLIT)
    .map(dedashSentence)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Keys whose STRING values are identifiers, not prose: the rendering side joins
 * rows to sections by ad name and by stage name, so rewriting the punctuation
 * inside one silently breaks the join. URLs are excluded for the same reason.
 */
const IDENTIFIER_KEYS = new Set([
  'ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name',
  'stage', 'date', 'key', 'id', 'section', 'section_key',
]);

const isUrlish = (text: string): boolean => /^https?:\/\//i.test(text.trim());

/** Only plain JSON objects are walked — a Map or a class instance passes through whole. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const DEEP_DEPTH_CAP = 12;

function walk(
  value: unknown,
  keyName: string | undefined,
  depth: number,
  rewrite: (text: string) => string,
): unknown {
  if (depth > DEEP_DEPTH_CAP) return value;
  if (typeof value === 'string') {
    if (keyName && IDENTIFIER_KEYS.has(keyName)) return value;
    if (isUrlish(value)) return value;
    return rewrite(value);
  }
  // An array's items inherit their parent key, so `gaps: string[]` is prose and
  // an array under an identifier key stays untouched.
  if (Array.isArray(value)) return value.map((item) => walk(item, keyName, depth + 1, rewrite));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, k, depth + 1, rewrite);
    return out;
  }
  return value;
}

/**
 * Apply ONE string rewrite to every prose string at any depth, on the same
 * terms dedashDeep uses: identifiers and URLs untouched, non-mutating, and a
 * throw costs the rewrite rather than the section.
 */
export function mapDeepStrings<T>(value: T, rewrite: (text: string) => string): T {
  try {
    return walk(value, undefined, 0, rewrite) as T;
  } catch {
    return value;
  }
}

/**
 * The em-dash pass over EVERY string at any depth of a section: the model writes
 * dashes into `biggest_leak.read`, `opportunities[]`, `winners[].why`,
 * `angle_patterns[]`, `gaps[]` and `key_stat` as readily as into the summary,
 * and the rendered page is grepped for em-dashes as a hard gate. Identifiers and
 * URLs are left alone (IDENTIFIER_KEYS). Pure, non-mutating, idempotent; banned
 * phrases are NOT touched here, since stripping a sentence out of structured
 * data would leave a field asserting half a thing.
 */
export function dedashDeep<T>(value: T): T {
  return mapDeepStrings(value, dedash);
}

/** Which banned phrases the text still contains (labels, in the listed order). */
export function findBannedPhrases(text: string): string[] {
  if (!text) return [];
  return BANNED.filter((b) => b.re.test(text)).map((b) => b.label);
}

/** Drop every sentence carrying a banned phrase. May legitimately return ''. */
export function stripBannedSentences(text: string): string {
  if (!text) return text;
  return text
    .split(SENTENCE_SPLIT)
    .filter((s) => findBannedPhrases(s).length === 0)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** One customer-facing string, scrubbed, with whatever filler survived. */
export function scrubText(text: string | undefined): { text: string | undefined; banned: string[] } {
  if (typeof text !== 'string' || text.length === 0) return { text, banned: [] };
  const out = dedash(text);
  return { text: out, banned: findBannedPhrases(out) };
}

export interface ScrubbableSection {
  summary?: string;
  next_step?: string;
  warnings?: string[];
}

/**
 * Scrub every customer-facing string on a section. `banned` is the caller's cue
 * to spend ONE rewrite retry; `strip: true` applies the deterministic fallback
 * (drop the offending sentence) for the second pass.
 */
export function scrubSectionProse<T extends ScrubbableSection>(
  section: T,
  opts: { strip?: boolean } = {},
): { section: T; banned: string[] } {
  const banned = new Set<string>();
  const one = (text: string | undefined): string | undefined => {
    const r = scrubText(text);
    for (const b of r.banned) banned.add(b);
    if (opts.strip && r.banned.length > 0) return stripBannedSentences(r.text!);
    return r.text;
  };
  const out: T = { ...section };
  if (typeof section.summary === 'string') out.summary = one(section.summary);
  if (typeof section.next_step === 'string') out.next_step = one(section.next_step);
  if (Array.isArray(section.warnings)) {
    out.warnings = section.warnings.map((w) => one(w) ?? '').filter((w) => w.length > 0);
  }
  return { section: out, banned: [...banned] };
}

/**
 * The em-dash pass for a lead insight, headline and detail plus anything nested
 * a ranking call decides to return. Filler is NOT stripped here: an insight is
 * three sentences long, so removing one would leave a headline pointing at
 * nothing. The section-level scrub is where a banned phrase gets caught.
 */
export function scrubInsightProse<T extends { headline?: string; detail?: string }>(insight: T): T {
  return dedashDeep(insight);
}
