/**
 * The Governor — Ada 2.0's graded judgment layer.
 *
 * The hard guard (guard.ts) answers a BINARY question: "is this action
 * categorically forbidden?" The Governor answers the NEXT question the guard
 * cannot: "given the action is allowed, how risky is it, and how much human do we
 * put in the loop?" This is the constraint that buys loop-capability with
 * pipeline-safety — it lets the loop act boldly on reversible, low-blast,
 * high-confidence moves while forcing a human onto the irreversible/uncertain
 * ones. (See docs/ada-2.0-research-2026-06-28.md §4.7 + §5.)
 *
 * It scores every WRITE on three axes:
 *   blast radius   — one paused ad set vs. the shared worker every client needs
 *   reversibility  — free-undo (pause-flip / config row) → cheap-undo (paused
 *                    objects, a sent Slack message) → irreversible-with-cost
 *                    (live spend) → forbidden (delete; the guard already blocks)
 *   confidence     — the loop's calibrated confidence in THIS decision (0..1)
 *
 * …and routes to one of three UX tiers (plus a hard "blocked"):
 *   auto-heal     (Tier 1) — high confidence + reversible + low blast: just do it,
 *                            retry, show a collapsed resolved line.
 *   try-then-show (Tier 2) — medium confidence (or a client-strategy blast): test
 *                            the hypothesis first (probe), then show the result to
 *                            confirm. "I checked X, it confirms Y — approve?"
 *   options       (Tier 3) — low confidence OR irreversible/high blast: 2–3
 *                            pre-computed options, recommendation first. Rare.
 *   blocked       (Tier 0) — forbidden (delete / un-listed): never autonomous.
 *
 * Pure + deterministic, so it is unit-selfcheckable exactly like the guard
 * (tests/governor.test.ts).
 *
 * NOTE on today's surface: every Ada write currently tops out at "cheap-undo"
 * (everything is created PAUSED; delete is hard-blocked; un-pause / go-live is
 * held OUTSIDE Ada's tools). So the irreversible-with-cost tier is DORMANT until
 * Ada is given a spending verb — it is encoded now so the Governor is ready the
 * day it isn't.
 */
import { bareToolName } from './guard.js';

export type Reversibility = 'free-undo' | 'cheap-undo' | 'irreversible' | 'forbidden';
export type Blast = 'low' | 'medium' | 'high';
export type Confidence = 'low' | 'medium' | 'high';
export type Tier = 'blocked' | 'auto-heal' | 'try-then-show' | 'options';

export interface GovernorVerdict {
  tool: string;
  bareName: string;
  tier: Tier;
  blast: Blast;
  reversibility: Reversibility;
  confidence: Confidence;
  /** Whether the tool was explicitly classified (vs. a conservative default). */
  known: boolean;
  rationale: string;
}

/**
 * Reversibility per write class — the taxonomy from the research §5 table.
 * Anything not listed (but allow-listed by the guard) defaults to 'cheap-undo'
 * AND is treated as unclassified, so it never silently auto-heals.
 */
const REVERSIBILITY: Record<string, Reversibility> = {
  // free-undo — internal/re-writable, or the undo verb itself
  pause_launch: 'free-undo', // the system's own undo primitive
  update_landing_page_mapping: 'free-undo',
  remember: 'free-undo',
  log_decision: 'free-undo',
  correct_learning: 'free-undo',
  correct_methodology: 'free-undo',
  update_task: 'free-undo',
  update_aot_task_status: 'free-undo',
  update_aot_ad_set_stage: 'free-undo',
  // cheap-undo — undoable but leaves a trace / a manual step / is socially visible
  set_adset_marker: 'cheap-undo', // cleared manually in Ads Manager by design
  upload_to_media_library: 'cheap-undo', // additive; no spend, no live ad
  launch_ads: 'cheap-undo', // creates PAUSED objects; undo = pause/remove in Ads Manager
  post_message: 'cheap-undo', // a sent Slack message is seen even if edited/deleted
  reply_in_thread: 'cheap-undo',
  create_task: 'cheap-undo',
  add_task_comment: 'cheap-undo',
  // irreversible-with-cost — DORMANT today (held outside Ada's tools). Encoded so
  // the Governor is ready the day Ada gets a go-live / spend verb.
  unpause_adset: 'irreversible',
  go_live: 'irreversible',
  set_budget: 'irreversible',
};

/**
 * Blast radius per write class. Default = 'low' (a single object / one ad set).
 * 'medium' = touches a whole client's optimisation/strategy. 'high' = shared
 * infra everyone depends on. Today almost everything is 'low'; the bigger-blast
 * verbs are the dormant spend verbs.
 */
const BLAST: Record<string, Blast> = {
  set_budget: 'medium',
  unpause_adset: 'medium',
  go_live: 'medium',
};

const DELETE_PATTERN = /(^|_)(delete|destroy|purge|remove)(s|d)?(_|$)/i;

function classifyConfidence(c: number): Confidence {
  if (c >= 0.8) return 'high';
  if (c >= 0.5) return 'medium';
  return 'low';
}

export interface GovernorInput {
  /** MCP-qualified (`mcp__ada-tools__launch_ads`) or bare tool name. */
  toolName: string;
  /** The loop's calibrated confidence in THIS specific decision, 0..1. */
  confidence: number;
  /** Optional overrides — e.g. a probe lowered reversibility, or input made blast bigger. */
  blast?: Blast;
  reversibility?: Reversibility;
}

/** The core Governor decision. Pure function — easy to unit-test / selfcheck. */
export function govern(inp: GovernorInput): GovernorVerdict {
  const bare = bareToolName(inp.toolName);
  const confidence = classifyConfidence(inp.confidence);
  const isDelete = DELETE_PATTERN.test(bare);
  const known = bare in REVERSIBILITY || isDelete;
  const reversibility: Reversibility =
    inp.reversibility ?? (isDelete ? 'forbidden' : REVERSIBILITY[bare] ?? 'cheap-undo');
  const blast: Blast = inp.blast ?? BLAST[bare] ?? 'low';

  const base = { tool: inp.toolName, bareName: bare, blast, reversibility, confidence, known };

  // Hard rail: forbidden actions are never autonomous (mirrors the guard's delete rail).
  if (reversibility === 'forbidden') {
    return { ...base, tier: 'blocked', rationale: `forbidden action (${bare}) — never autonomous` };
  }
  // Irreversible-with-cost or high blast → always a human decision (Tier 3).
  if (reversibility === 'irreversible' || blast === 'high') {
    return {
      ...base,
      tier: 'options',
      rationale: `${reversibility === 'irreversible' ? 'irreversible-with-cost' : 'high blast radius'} → options + recommendation`,
    };
  }

  // Reversible (free/cheap), low/medium blast → route by confidence.
  let tier: Tier = confidence === 'high' ? 'auto-heal' : confidence === 'medium' ? 'try-then-show' : 'options';

  // A medium-blast move (touches client strategy) never silently auto-heals,
  // even at high confidence — show the work. Drop one tier.
  if (blast === 'medium' && tier === 'auto-heal') tier = 'try-then-show';
  // An UNCLASSIFIED write never silently auto-heals — we don't know its blast/undo
  // for sure, so surface it (unless the caller gave an explicit reversibility).
  if (!known && tier === 'auto-heal' && inp.reversibility === undefined) tier = 'try-then-show';

  const rationale =
    tier === 'auto-heal'
      ? 'high confidence + reversible + low blast → auto-heal'
      : tier === 'try-then-show'
        ? blast === 'medium'
          ? 'reversible but client-strategy blast → try-then-show'
          : !known
            ? 'reversible but unclassified write → show the work'
            : 'medium confidence + reversible → try-then-show (probe, then confirm)'
        : 'low confidence → options + recommendation';

  return { ...base, tier, rationale };
}
