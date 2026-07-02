/**
 * The Account Model — typed, per-field-provenance context an audit WRITES
 * (Ada 2.0 Phase C / context-generation design C0+C1).
 *
 * WHY: context generation is THE problem (design doc 2026-07-02 §1). The audit
 * already computes most of what a new account's context needs and then
 * evaporates it into one report. This module turns those same deterministic
 * pulls into durable, queryable facts — each one tagged with where it came
 * from and how sure we are, because WRONG context is worse than NO context
 * (the JVA stale-learnings lesson). Inferred facts never masquerade as
 * declared ones; the uninferables (targets, margins) become open questions
 * for the human, not silent guesses.
 *
 * The load-bearing inference is the BUSINESS MODEL classification (the BFM
 * lesson: zeroed e-com events read as "broken tracking" until the trial-model
 * lens landed) — everything else hangs off it, so it leads the fact list and
 * carries its evidence.
 *
 * Storage ruling (Dan 2026-07-02): typed model in Supabase (`account_models`),
 * narrative learnings in the AOT Memory store; the injection layer composes
 * both. Boundary flagged against docs/agent-memory-system/spec.md §7.1.
 *
 * Pure module: rows in → model out; unit-tested (tests/account-model.test.ts).
 */

export type FactSource = 'account_structure' | 'event_stream' | 'creatives' | 'config' | 'human_stated';

export interface AccountFact {
  key: string;
  /** Short human label, e.g. "Business model". */
  label: string;
  /** Human-readable value — what the client reads and corrects. */
  value: string;
  source: FactSource;
  /** 0..1 — rendered as Confident / Likely / Unsure on the page. */
  confidence: number;
  /** The specific numbers/rows this was inferred from. */
  evidence?: string;
  observed_at: string;
}

export interface OpenQuestion {
  key: string;
  question: string;
}

export interface AccountModel {
  business_model: string;
  facts: AccountFact[];
  open_questions: OpenQuestion[];
}

export interface AccountModelInputs {
  currency: string;
  observedAt: string;
  /** 30-day account-level event totals. */
  totals30: {
    spend: number;
    impressions: number;
    purchases: number;
    purchase_value: number;
    leads: number;
    complete_registrations: number;
    add_to_carts: number;
    checkouts_initiated: number;
    content_views: number;
  };
  adsWithSpend30: number;
  /** null when the account runs no video. */
  videoSpendSharePct: number | null;
  campaigns: Array<{ name: string; spend: number }>;
  /** Spend by landing-page market/path (from ad_daily), already aggregated. */
  markets: Array<{ market: string; spend: number }>;
  landingPaths: Array<{ path: string; spend: number }>;
  /** From the read-only ad-set config read; absent when the fetch failed. */
  optimizationGoals?: Array<{ goal: string; spend: number }>;
}

const pct = (num: number, den: number): number => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

/**
 * Business-model classification from the 30d event mix. Deliberately coarse —
 * a wrong-but-confident classification poisons every downstream judgment, so
 * ambiguous mixes get LOW confidence and an open question instead of a guess.
 */
export function classifyBusinessModel(t: AccountModelInputs['totals30']): {
  model: string;
  confidence: number;
  evidence: string;
  question: OpenQuestion | null;
} {
  const hasRevenue = t.purchases > 0 && t.purchase_value > 0;
  const hasFunnel = t.add_to_carts > 0 || t.checkouts_initiated > 0;
  const leadsDominant = t.leads > 0 && t.leads > t.purchases * 3;

  if (hasRevenue && hasFunnel && !leadsDominant) {
    return {
      model: 'ecommerce',
      confidence: 0.85,
      evidence: `${t.purchases} purchases with revenue + on-site funnel events (${t.add_to_carts} add-to-carts, ${t.checkouts_initiated} checkouts) in 30 days`,
      question: null,
    };
  }
  if (hasRevenue && !hasFunnel) {
    // The BFM shape: purchases fire but no ATC/checkout — app trial, offsite
    // checkout, or subscription platform. Never read this as "broken tracking".
    return {
      model: 'purchase-based, no on-site funnel events (app subscription or offsite checkout?)',
      confidence: 0.5,
      evidence: `${t.purchases} purchases with revenue but zero add-to-cart/checkout events — purchases likely fire from an app store, trial flow, or offsite checkout`,
      question: {
        key: 'business_model',
        question: 'Your purchases fire without any add-to-cart or checkout events — is this an app/subscription business or an offsite checkout? Knowing this changes how we read your whole funnel.',
      },
    };
  }
  if (leadsDominant && !hasRevenue) {
    return {
      model: 'lead_gen',
      confidence: 0.8,
      evidence: `${t.leads} leads vs ${t.purchases} purchases in 30 days — lead volume is the account's real output`,
      question: null,
    };
  }
  if (leadsDominant && hasRevenue) {
    return {
      model: 'mixed (leads + purchases)',
      confidence: 0.45,
      evidence: `${t.leads} leads AND ${t.purchases} purchases with revenue in the same 30 days`,
      question: {
        key: 'business_model',
        question: 'We see meaningful lead volume AND purchase revenue — which is the business, and which is a byproduct?',
      },
    };
  }
  return {
    model: 'unknown',
    confidence: 0.2,
    evidence: `no clear conversion signal in 30 days (${t.purchases} purchases, ${t.leads} leads)`,
    question: {
      key: 'business_model',
      question: 'We could not read a clear conversion model from the account — what does a "win" look like for you (a sale, a lead, an install, a booking)?',
    },
  };
}

export function buildAccountModel(inp: AccountModelInputs): AccountModel {
  const t = inp.totals30;
  const facts: AccountFact[] = [];
  const questions: OpenQuestion[] = [];
  const fact = (f: Omit<AccountFact, 'observed_at'>): void => {
    facts.push({ ...f, observed_at: inp.observedAt });
  };

  // 1. Business model — the lens everything else is read through.
  const bm = classifyBusinessModel(t);
  fact({
    key: 'business_model',
    label: 'Business model',
    value: bm.model,
    source: 'event_stream',
    confidence: bm.confidence,
    evidence: bm.evidence,
  });
  if (bm.question) questions.push(bm.question);

  // 2. What each Meta event MEANS here (the conversion-event map skeleton).
  const eventBits: string[] = [];
  if (t.purchases > 0) eventBits.push(`Purchase ${t.purchases.toLocaleString('en-US')}`);
  if (t.leads > 0) eventBits.push(`Lead ${t.leads.toLocaleString('en-US')}`);
  if (t.complete_registrations > 0) eventBits.push(`CompleteRegistration ${t.complete_registrations.toLocaleString('en-US')}`);
  if (t.add_to_carts > 0) eventBits.push(`AddToCart ${t.add_to_carts.toLocaleString('en-US')}`);
  if (t.checkouts_initiated > 0) eventBits.push(`InitiateCheckout ${t.checkouts_initiated.toLocaleString('en-US')}`);
  if (eventBits.length) {
    fact({
      key: 'conversion_events',
      label: 'Conversion events firing (30 days)',
      value: eventBits.join(' · '),
      source: 'event_stream',
      confidence: 0.95,
      evidence: 'counts from the account-level daily sync',
    });
  }

  // 3. Primary KPI as the account actually reads.
  fact({
    key: 'primary_kpi',
    label: 'How we read your results',
    value: t.purchase_value > 0 ? `revenue-based (Meta ROAS; ${inp.currency})` : 'cost per result (no purchase value reported)',
    source: 'event_stream',
    confidence: 0.85,
    evidence: t.purchase_value > 0 ? `purchase value reported in ${inp.currency}` : 'no purchase value in the window',
  });

  // 4. Spend level.
  fact({
    key: 'spend_level',
    label: 'Spend level (30 days)',
    value: `${Math.round(t.spend).toLocaleString('en-US')} ${inp.currency} across ${inp.adsWithSpend30} ads`,
    source: 'event_stream',
    confidence: 0.95,
  });

  // 5. Markets — from where the ads actually send people.
  const marketTotal = inp.markets.reduce((s, m) => s + m.spend, 0);
  const topMarkets = [...inp.markets].sort((a, b) => b.spend - a.spend).slice(0, 4);
  if (topMarkets.length > 0 && marketTotal > 0) {
    fact({
      key: 'markets',
      label: 'Markets (by landing-page spend)',
      value: topMarkets.map((m) => `${m.market} (${pct(m.spend, marketTotal)}%)`).join(', '),
      source: 'creatives',
      confidence: 0.7,
      evidence: 'landing-page market detected on the ads carrying spend',
    });
  }

  // 6. What they sell — the top landing paths as a product proxy.
  const pathTotal = inp.landingPaths.reduce((s, p) => s + p.spend, 0);
  const topPaths = [...inp.landingPaths].sort((a, b) => b.spend - a.spend).slice(0, 3);
  if (topPaths.length > 0 && pathTotal > 0) {
    fact({
      key: 'top_destinations',
      label: 'Where the money sends people',
      value: topPaths.map((p) => `${p.path} (${pct(p.spend, pathTotal)}%)`).join(', '),
      source: 'creatives',
      confidence: 0.6,
      evidence: 'destination paths on the ads carrying spend — a proxy for the products/offers being pushed',
    });
  }

  // 7. Structure.
  const campTotal = inp.campaigns.reduce((s, c) => s + c.spend, 0);
  const topCamp = [...inp.campaigns].sort((a, b) => b.spend - a.spend)[0];
  if (topCamp && campTotal > 0) {
    fact({
      key: 'structure',
      label: 'Account structure',
      value: `${inp.campaigns.length} campaigns with spend; "${topCamp.name}" carries ${pct(topCamp.spend, campTotal)}%`,
      source: 'account_structure',
      confidence: 0.9,
    });
  }

  // 8. Creative mix.
  if (inp.videoSpendSharePct !== null) {
    fact({
      key: 'creative_mix',
      label: 'Creative mix',
      value: `${inp.videoSpendSharePct}% of spend on video`,
      source: 'creatives',
      confidence: 0.85,
    });
  }

  // 9. What Meta is told to optimize for (when the ad-set read succeeded).
  if (inp.optimizationGoals && inp.optimizationGoals.length > 0) {
    const goalTotal = inp.optimizationGoals.reduce((s, g) => s + g.spend, 0);
    const goals = [...inp.optimizationGoals].sort((a, b) => b.spend - a.spend).slice(0, 4);
    fact({
      key: 'optimization_goals',
      label: 'What Meta is optimizing for',
      value: goals.map((g) => `${g.goal} (${pct(g.spend, goalTotal)}% of spend)`).join(', '),
      source: 'account_structure',
      confidence: 0.9,
      evidence: 'ad-set optimization goals, read directly from the account',
    });
  }

  // The uninferables — always asked, never guessed (magic-audit binding ruling:
  // ask the goal; economics NEVER inferred silently, design §3).
  questions.push({
    key: 'target',
    question: t.purchase_value > 0
      ? 'What ROAS (or CPA) makes an ad profitable for you? Every judgment in this audit sharpens once we know your real breakeven.'
      : 'What is a lead/result worth to you (target cost per result)? Every judgment in this audit sharpens once we know it.',
  });

  return { business_model: bm.model, facts, open_questions: questions };
}

/**
 * Merge a fresh inference into the stored model: human_stated facts are the
 * highest trust class and are NEVER overwritten by inference (design §2 —
 * that's the whole point of harvesting corrections). Inferred facts refresh.
 */
export function mergeAccountModel(
  prev: Pick<AccountModel, 'facts'> | null,
  next: AccountModel,
): AccountModel {
  if (!prev) return next;
  const humanStated = new Map(
    prev.facts.filter((f) => f.source === 'human_stated').map((f) => [f.key, f]),
  );
  const facts = next.facts.map((f) => humanStated.get(f.key) ?? f);
  // Human-stated facts whose key the new inference didn't produce still survive.
  const nextKeys = new Set(next.facts.map((f) => f.key));
  for (const [key, f] of humanStated) {
    if (!nextKeys.has(key)) facts.push(f);
  }
  // A human-stated business model answers the open question.
  const bmFact = facts.find((f) => f.key === 'business_model');
  const open_questions =
    bmFact?.source === 'human_stated'
      ? next.open_questions.filter((q) => q.key !== 'business_model')
      : next.open_questions;
  return {
    business_model: bmFact?.value ?? next.business_model,
    facts,
    open_questions,
  };
}
