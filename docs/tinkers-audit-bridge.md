# The Tinkers audit bridge

The cold-audit rail (`POST /api/audit/trigger` → `runColdAudit` → `runMagicAudit`)
only speaks the legacy data model: `ada_leads` for the goal, `meta_connections`
for the token, `magic_audits` for the report. The Tinkers monorepo is a separate
application with a separate database, and it triggers this endpoint with its
**organization id** in `userId`. Nothing in our tables resolves that id, so
before this bridge those audits died at token resolution.

The bridge adds a second path through the same machinery: the account data is
READ from Tinkers' generation API (no credential crosses the seam — they return
data, never a Meta token), results go BACK to Tinkers, and we never touch
their database.

**The agency path is untouched.** A body without the bridge marker runs the
exact code it ran before — same idempotency reads, same `runColdAudit`, same
`ada_leads.audit_token` write. `tests/audit-trigger.test.ts` asserts the
branching in both directions.

## The trigger

```jsonc
// legacy (agency / ada_leads lead) — unchanged
{ "userId": "<auth user uuid>" }

// bridged (Tinkers monorepo org)
{ "userId": "<organizationId>", "auditId": "<tinkers audit row id>", "source": "tinkers" }
```

Both carry `X-Ada-Secret: $AUDIT_TRIGGER_SECRET` and both answer `202 {"status":"accepted"}`
with the audit running async. The bridge path is taken only when BOTH
`source === "tinkers"` and a non-empty `auditId` are present; half a marker
falls back to the legacy path. With `TINKERS_BASE_URL` or
`TINKERS_AUDIT_SEAM_SECRET` unset, the bridge path answers `503` (the same
shape `AUDIT_TRIGGER_SECRET` uses when it is unset) and starts nothing.

The bridge path deliberately SKIPS the legacy idempotency reads — they cannot
resolve a monorepo org. Tinkers' own trigger is idempotent (one live audit per
lead org), and the in-process running set below is the burst guard.

## The seam — no credential ever crosses it

Tinkers' ruling (2026-08-20): they return DATA, never a Meta token — their
plaintext token never leaves their meta package, so a compromised generator
cannot spend a customer's ad account. The audit id in every path is the tenant
capability: their row's own organization decides everything, and an unknown,
revoked or expired audit is their 404.

**Reads** — `Authorization: Bearer $TINKERS_AUDIT_SEAM_SECRET` (the same secret
that signs the write-backs; one secret for the whole boundary):

```
GET {TINKERS_BASE_URL}/api/generation/:auditId/account
  → { ok, account: { externalId, name, currency, timezone } }
GET {TINKERS_BASE_URL}/api/generation/:auditId/ad-days?since&until
  → { ok, rows: [normalized ad-level daily rows], partial }
     one ≤31-day window per request — their functions stop at 300s, so the
     slicing IS the contract (a window past the cap is refused, not truncated);
     a failed slice costs that slice (failedSlices), never the audit
GET {TINKERS_BASE_URL}/api/generation/:auditId/creatives
  → { ok, creatives: [{ adId, adName, landingUrl, mediaType }] }
GET {TINKERS_BASE_URL}/api/generation/:auditId/creative-media?adIds=<top 12>
  → { ok, ads: [{ adId, body, headline, videoUrl, imageUrl, posterUrl }] }
     30-minute signed URLs onto their media store — their connect burst
     downloads the real files at Meta connect (full images, playable mp4s),
     where ads_read Graph would give us a 64×64 thumbnail
```

`toRawAdDay` maps their normalized rows onto the raw Graph row shape
`buildColdRows` consumes (loose on purpose: a field the mapper cannot place
costs that field, never the row; thruplays land back under the `video_view`
action type Meta itself uses, and `video_view` is re-injected from `videoPlays`
so hook rates survive).

**Tokenless sections.** Sections whose reads only a connection token could
serve run as `planned` (TOKENLESS_SKIP_SECTIONS in magic-audit.ts):
placement_breakdown, audience_breakdown, saturation, optimization_events,
learning_limited, targeting_split, account_activity, competitor_teardown. An
honest gap, not an error — and the road back is more generation endpoints, not
a credential. The gate matters twice: `metaTokenFor('')` falls back to the
AGENCY token, so a tokenless cold run passes `''` (falsy) to every per-section
Graph helper — probing a stranger's account with our own credential is the one
call this path must never make.

**creative_analysis runs**, tokenless, off the store media: the winners' words
come with the media payload, `pickMedia` prefers a stored playable mp4 or full
image over everything the tokenless path could otherwise reach, and a stored
poster frame still beats a Graph thumbnail. The own-Ads-Library fallback is
unavailable (resolving the page needs a token) — unresolved ads are reported as
such, the section's normal degradation.

**Write-backs** — unchanged: HMAC-SHA256 over the exact JSON bytes of the body,
hex digest, in the `x-tinkers-signature-256` header, under
`TINKERS_AUDIT_SEAM_SECRET`.

**`POST {TINKERS_BASE_URL}/api/webhooks/audit-complete`** — contract v1.1: EVERY
content payload is a partial, including the last one, and the audit is sealed by
a separate message that carries no content at all.

```jsonc
// content — sent repeatedly as the report fills in, the accumulated row last
{ "auditId": "…", "partial": true, "sections": …, "scorecard": …, "leadInsights": …,
  "recognition": …, "workLog": …, "costUsd": 1.23 }

// completion — Tinkers flips the row COMPLETE and emails from what it stored
{ "auditId": "…", "finalize": true }
```

Splitting completion off the last content payload keeps the finalize call small
enough to clear any body cap no matter how fat the report got.

Our columns are snake_case (`lead_insights`, `work_log`, `cost_usd`); the
contract is camelCase. `toTinkersPatch` does that mapping and drops the keys
that are ours alone (`status`, `updated_at`). The answer is
`{ received, recorded }`; `recorded: false` is logged as a warning and never
retried — Tinkers' own sweep is the fallback. On the finalize message that
warning is worded deliberately ("audit may already be sealed — the sweep
reconciles if not") and must never read as a failed audit: Tinkers only accepts
content writes while the audit is RUNNING, so a finalize that timed out on our
side but landed on theirs answers `recorded: false` on the retry — with the
audit complete and its customer email already sent.

Reports are chained rather than fired in parallel, so a stale `sections`
snapshot cannot land after a newer one and undo visible progress on the page
that polls them.

`toTinkersPatch` runs on EVERY payload — there is one call site (`reportInOrder`
in `runBridgedColdAudit`), and it is the only caller of `reportAuditUpdate` in
the codebase. This matters more than it looks: Tinkers' zod strips unknown keys,
so a top-level snake_case key arrives as no content at all — `recorded: false`,
sections silently lost, HTTP 200. The mirrored patches are our raw column names
by construction, so the mapping cannot be skipped for the progressive ones
"because they're just partials". Pinned by `runBridgedColdAudit reporting >
maps EVERY payload, not just the last one`, which asserts no key on any posted
body contains an underscore, and by `AuditOptions.onRowUpdate > hands over our
raw snake_case column names — the shapes the bridge must map`, which fails if
the orchestrator ever emits a column shape the bridge does not know.

A patch whose mapped form holds no content key (`sections`, `scorecard`,
`leadInsights`, `recognition`, `workLog`) is not posted at all — the
orchestrator's closing `{ status, cost_usd }` write maps to `costUsd` alone,
which Tinkers stores nothing from, so posting it would earn a `recorded: false`
warning on every healthy run.

### A failed audit is never finalized

When the run ends with section errors (the orchestrator writes `status: 'error'`
to its own row), the content still goes over as a partial — the evidence is
worth having — but the finalize message is NOT sent. Tinkers' row stays RUNNING,
so it does not flip COMPLETE, does not mail "I found something", and does not
burn the one-ever email latch on a broken report; their 24h fallback rail
handles the lead honestly instead. Both branches are tested.

### One audit per org at a time

`runBridgedColdAudit` keeps an in-process set of organization ids with a run in
flight. A second trigger for an org already running logs and returns
`{ status: 'skipped', reason: 'already_running' }` without starting anything.
The trigger is fire-and-forget from Tinkers, so without this a double-click
costs two data pulls, two LLM bills, and two streams of partials interleaving
into one row. The guard is per-process (a restart clears it) — it is a burst
guard, not a distributed lock; Tinkers' own one-live-audit-per-lead trigger is
the durable half of idempotency.

### Redaction stays, even tokenless

No token crosses this seam any more, but `redactSecrets` (log lines) and
`redactPayload` (every string INSIDE every payload) both remain: section errors
carry raw `err.message` from whatever threw, the legacy path still interpolates
tokens into Graph URLs inside the same orchestrator, and this content is
rendered on a public `/audit/<token>` page. The scrub sits where a secret COULD
be known so that class of bug cannot reach the wire even once. Two tests pin it.

## What changed inside the audit

`magic-audit.ts` gained ONE optional field:

```ts
onRowUpdate?: (patch: Record<string, unknown>, meta: { final: boolean }) => void | Promise<void>;
```

Every `updateRow` patch is mirrored to it (fire-and-forget, fail-soft), plus
one final call with the accumulated row state — that last one IS awaited, so a
bridged run reports completion before it resolves. A caller that passes nothing
gets the old behavior exactly; `tests/magic-audit-row-mirror.test.ts` runs the
same audit with and without the option and asserts the sequence of writes to
`magic_audits` is identical.

Nothing else in `magic-audit.ts` was touched: no section, no prompt, no cost
meter, no ordering.

## The owner's own answers

`GET /api/generation/:auditId/context` (Bearer-authorized like every other
generation read, no provider touched) carries what the customer already told
Tinkers: `goal` (the funnel answer), `grossMarginPct`, `interview`
(who_runs_ads / pain_point / tried / agency_fee), `rivals`, and `accountTarget`
(the same target mirrored onto the account they picked).

`fetchTinkersLeadContext` reads it and threads it into the cold injection, so
`buildColdKnowledge` can cite the number AS THE OWNER'S: "the CPL 40 target you
set when you connected" for a funnel answer, "your stated target of 40 CPL" for
an account target, and the margin drives the breakeven derivation it always
drove. **"No target has been set" now appears only when goal AND accountTarget
are both null.** A stated cost target also becomes the budget scatter's line
(`cpr_line_source: "owner_target"`), which is the one number on that chart that
was previously borrowed from nowhere.

The read is CONTAINED: a 404, a not-ready answer, a changed contract or an
outage all cost the same thing, the target we would have cited. The endpoint
ships on Tinkers' schedule and an audit that died because it could not read an
optional answer would be a worse report than one that honestly says no target
was given.

## The site walk (section key `message_match`)

The audit knew where the money went and what the ads said, and never opened the
page the money lands on. It does now: ONE page, the top destination by spend
(resolved by the same `rankDestinationsBySpend` the landing chapter uses, so the
two can never disagree about which page carries the money), and one question,
does the top ad's promise appear on it?

`data` shape, for the renderer:

```json
{ "window_days": 30, "currency": "USD",
  "verdict": "matched | partial | mismatch | inconclusive",
  "evidence_quote": "Life cover from 12 USD a month",
  "page": { "url": "...", "final_url": "...", "http_status": 200,
            "spend_30d": 5577, "spend_share_pct": 61.2, "ads_pointing_here": 7,
            "headline": "...", "page_title": "...", "offer_sentence": "...",
            "primary_cta": "Start my free quote",
            "social_proof": true, "social_proof_evidence": "Rated 4.8 out of 5 by 1,204 families" },
  "ad": { "ad_id": "...", "ad_name": "...", "spend_30d": 1204, "words": "..." },
  "checks": [{ "promise": "code SAVE20", "found_on_page": false,
               "page_evidence": null, "source": "deterministic | read" }],
  "signal": true }
```

The rules that make it safe to print:

- **One page, one fetch** (plus at most one redirect). No crawling.
- **Guarded**: https only, public hosts only, standard ports only, a byte cap, a
  timeout, no auth headers, and a user agent that says who we are. A URL that
  fails any of these is refused before the request leaves.
- **Every verdict stronger than `inconclusive` carries a verbatim page quote**,
  checked against the page's own text. For a kept promise it is where the page
  keeps it; for a mismatch it is what the page says instead. A quote the page
  does not carry is dropped, so a model claim we cannot verify can never become
  a finding, and an unverifiable claim never becomes evidence of absence either.
- **The string search beats the model** on the same promise: whether a page
  prints SAVE20 is a search, not a judgment.
- **`inconclusive` is never alarmed**: no warning, `signal: false`, no next step.
- **Contained**: a blocked, slow, script-only or broken page stores the section
  `status: "skipped"` with a reason in plain words, and the landing chapter above
  keeps today's wording exactly. The walk is time-capped and cannot fail an audit.

Full URLs reach it differently on the two paths and land in one map: the bridge
takes them from Tinkers' `/creatives` answer (`landingUrls`, query dropped), and
the warehouse path uses the ones `checkAdDestinations` already resolves live from
each ad's creative.

## What the simulation round changed in the payload

A customer-simulation review of the first live regeneration found sentences a
reader could have disproved from the same payload. The generator-side fixes:

- `recognition.connection` (new, optional): ONE sentence joining two sections
  with a figure from each, written by one extra pass after the report is
  complete. It ships only when it names two different sections and carries a
  number, so a headline cannot pass as a connection. Absent when the report has
  fewer than two sections with a signal.
- `funnel_read.data.derived` no longer carries `roas`, `cpa` or `aov` on an
  account whose funnel kind is not `ecommerce`: the fields are ABSENT, not zero,
  because a `roas: 0` is what put a "ROAS 0" tile on a life-insurance account.
  It gains `cost_per_link_click`, and `trend_7d` carries `cost_per_lead` and
  drops the purchase pair on those accounts.
- The lead-insight ranker now receives the sections' own verdicts (which ads the
  fatigue chapter classified, with their money stats), the account's 30-day
  totals and the cost-trend chapter's CPM/CTR figures, as RULES: it may not call
  an ad fatiguing unless that chapter did, may not relabel a rate as a cost, may
  not state a percentage change the facts do not carry, and must check every
  superlative against the totals.
- Every synthesis prompt carries the honesty rules (no field names read aloud,
  creative claims scoped to the ads actually watched, no invented instant form
  when `landing_page_views` is above zero, the 28.6% weekend baseline, the
  missing-target caveat stated once and only by the funnel section) and the
  voice rules (plain operator language, no "not X but Y", no metaphors or
  taglines).
- The cold creative read states `creatives_watched` and `top_ads_in_facts` so a
  claim can be scoped to them, and a lead-gen ad's fallback stat is money per
  lead ("Meta CPL 18.6 USD") rather than a bare count or a ROAS multiple.

### Section fields the simulation round added

The page must read these rather than deriving them, because deriving them is
what produced the wrong numbers on the live report.

| Field | Section | Meaning |
|---|---|---|
| `ads[].spend_30d` | creative_fatigue | The ad's REAL summed spend over the last 30 days. Print this as "spend riding on this ad", never `recent_daily_spend * 30` (that turned 137/day into 4,110 on an account whose whole month was 8,999). |
| `ads[].cpl_first_half`, `ads[].cpl_last_14` | creative_fatigue | Cost per result in money, cpr mode only, null when that period booked none. `kpi_first_half`/`kpi_recent` stay unitless RATES and must never be labelled ROAS. |
| `dragging[]`, `dragging_note` | creative_fatigue | The correct "dragging the most spend" list: fatiguing ads with the low-frequency acquisition ads already excluded, ranked by real 30-day spend, each with a labelled `stat` and a `why`. Render as-is. When it is empty the note explains why and says where concentration is covered instead. |
| `breakeven_roas`, `gross_margin_pct` | creative_fatigue | ABSENT in cpr mode. Absence means the account has no breakeven. Do not default to 1: that default is what made every lead-gen ad read as "below breakeven". |
| `verdict`, `weeks`, `cpm_first/cpm_last/ctr_first/ctr_last`, `cpm_delta_pct`, `ctr_delta_pct`, `ctr_readable` | cost_trends | ONE computation owns the auction read. `weeks` is the real bucket count (the live page titled "12 weeks" over 14). A CTR down 25% or more while CPM holds is `ctr_down_cpm_held`, signal true, and the section says to rebuild creative. |
| `window_too_short`, `days_covered` | creative_cohorts | `true` means freshness is an artifact of a short read. The section is quiet, the scorecard drops the freshness grade, and the protect list withholds it (`whats_working.data.freshness_withheld`). |
| `top_ads[].name_shared_with_other_ad` | spend_concentration | Two different ads share this name. Disambiguate the row. |
| `top_evergreen`, `best_angle.spend_share_pct`, `freshness_withheld`, `cohort_days_covered` | whats_working | The protect list now names the ad and the angle it protects. |
| `window_days`, `window_start`, `window_end`, `delivery_days`, `window_spend`, `daily_avg` | account_facts | Every did-you-know sentence states its own window, and the daily average divides that window's spend by that window's days. `daily_avg * window_days` reconciles with `window_spend`. |

### The target gap (`funnel_read.data.target_gap`)

The headline the report was missing: what the distance to the owner's OWN stated
target costs per month. Computed in TypeScript, never by a model, because a
model asked to multiply 483 by 3.67 sometimes answers 1,600.

```json
{ "metric": "cpl", "target": 15, "cpl": 18.67, "leads_30d": 483,
  "monthly_over_target_usd": 1773,
  "formula": "483 leads x (18.67 - 15.00)",
  "recovery_cpl_usd": 14.36,
  "recovery_formula": "18.67 x (1 / 1.3)",
  "ctr_now": 1.0,  "ctr_now_basis": "measured link CTR over the last 30 days",
  "ctr_recoverable": 1.3, "ctr_recoverable_basis": "weekly average link CTR at the start of the cost-trend window",
  "currency": "USD" }
```

Absent unless the owner gave a cost target (the `/context` read) AND the account
is above it. The recovery figures are absent unless the cost-trend chapter found
a HIGHER click rate this account already held: it prices the same spend at a rate
they achieved, which is a recovery rather than a projection, and both rates carry
their basis because one is a 30-day measure and the other a weekly average.
`monthly_over_target_usd` keeps its name for the page, and `currency` says what
the unit actually is.

The funnel synthesis and the insight ranker both receive the same computed brief
with an instruction to quote the fields verbatim, so the report's number one
opportunity is this gap stated in money against their own target.

### Smaller payload changes from sim round two

- `funnel_read.data`/facts carry `cost_per_lead_direction` (`better|worse|flat`,
  a move under 2% is flat): the model called 19.57 against 19.63 "worse" because
  it had to work out that lower is better for a cost. It no longer decides.
- `creative_analysis` winners: a winner whose own last fortnight costs 25%+ more
  per result than its first half now carries both figures in its `why`,
  appended deterministically after synthesis rather than trusted to the prompt.
  The facts carry `cost_per_lead_first_half`, `cost_per_lead_last_14` and
  `cost_per_lead_decay_pct` per top ad, and the copy fields are renamed
  `headline_field` / `primary_text_field` so a quote can name which of the three
  sources it came from (headline field, primary text, or the words on the image).
- `message_match`: two promises resolving to the same page line count once, and
  a headline the markup prints twice is collapsed to the phrase.
- The scorecard's freshness dimension can be capped to `middle` with a citable
  reason (`{ value, capBand: 'middle', capReason }`), and is capped whenever a
  top-three spender's last fortnight costs 25%+ more per result than its own
  first half. Freshness measures how recently creative launched, so a young and
  decaying portfolio scores high on it, which is the wrong thing to hand a reader
  as a strength.

### The fatigue vocabulary, sim round two

`FatigueAd.class` values changed, because the old words claimed verdicts the
rules had refused (a 17-day ad whose cost per lead went 16.68 to 23.65 was
labelled `fresh`, and a 25.6% decliner `stable`):

| class | means |
|---|---|
| `fatiguing` | confirmed: declining AND confirmed on the recent window. Unchanged rule. |
| `declining_unconfirmed` | **new middle class**: down 25% or more, but too young or too thin to confirm. Describable as declining and unconfirmed. NOT a cut call. |
| `too_young_to_call` | was `fresh`. Under 21 days and not declining. |
| `stable` | now EARNED: the confirmation window holds within 25% of the first half. |
| `evergreen` | unchanged. |

Also on the fatigue data: `last_spend_date`, `days_since_last_spend`,
`still_spending`, `confirmation_days` per row; `assessed_spend`,
`daily_basis: "active_days"`, `sorted_by: "spend_30d"`, `ads_shown`, and the
three class counts on the section. `fatiguing_daily_burn` now counts only
still-spending ads, `ads` is ordered by 30-day spend, an ad with no 30-day spend
can never appear in `dragging`, and `signal` includes the unconfirmed decliners
so a section carrying an action row is not marked quiet. **Every per-ad daily
figure is that ad's own average while it was running, so the rows do not add up
to the account's daily spend** — the section says so once, and the page must not
sum them.

Cost trend now carries BOTH bases, each labelled: `cpm_delta_pct`/`ctr_delta_pct`
(`delta_basis: "thirds_average"`, with `delta_first_weeks`/`delta_last_weeks`)
and `cpm_chart_delta_pct`/`ctr_chart_delta_pct`
(`chart_delta_basis: "last_bucket_vs_first_bucket"`). **Label the chart's
endpoints from the chart deltas and the sentence from the thirds deltas**: the
live page mixed them (+23% on the chart, +6.8% in the prose). Every CTR level in
that section is named as a weekly average with its window.

Scatter: `plotted_set_label`, `flagged_off_chart`, `flagged_off_chart_reasons`.
A "the red dots are the past-peak ads" claim is only true when
`flagged_off_chart` is absent.

Day of week: a budget shift may only be built from `shift_advice` +
`shift_from_day` + `shift_to_day`, which exist only when the two days differ by
25% or more. `best_day`/`worst_day`/`gap_pct` stay as table facts;
`shift_withheld_reason` says why there is no advice. The live report moved budget
on a 2.5% spread.

## Two rules the report page depends on

**A quiet section carries no next step.** `data.signal === false` is a section
stating it found nothing worth acting on, and the page reads a `next_step` as an
action worth taking, so a section carrying both renders as a finding with no
finding in it (live, 2026-08-21: budget_scatter posted `signal: false` beside
"Move budget from the ads near 40 USD per result toward the ones near 17 USD").
`enforceQuietSection` drops the line in the ONE write path every section passes
through, so no compute function can forget the rule. The other direction is
fixed at the source: a wide cost-per-result spread across the plotted ads (the
dearest at least 1.5x the cheapest, reported as `data.spread_ratio`) IS a
signal, whatever the fatigue classes say.

**The work log passes the same dash gate as the sections.** Every `work_log`
line now goes through `dedash`, and the literal lines we own were rewritten with
house punctuation. Nothing customer-facing leaves here with an em-dash in it.

## The lens the report is read through

Every audit classifies the account's own 30-day event mix ONCE
(`readAccountLens`, `src/audit/account-model.ts`) and both states and enforces
that reading:

- **Stated.** The recognition payload carries two new keys the report page can
  render at the top: `lens` (`ecommerce` | `lead_gen` | `mixed` | `unknown`,
  the machine value) and `read_as` (the sentence, e.g. `Read as: lead
  generation. Inferred from 482 lead events and zero purchases in the last 30
  days.`). A reader who disagrees with the lens can only say so if we print it.
- **Enforced in the words.** On an account with no purchase revenue the budget
  scatter plots cost per result, not ROAS: `data.y_axis` is
  `cost_per_result`, `data.y_axis_label` reads `Cost per lead` where the lens
  says lead-gen, `breakeven_roas`/`gross_margin_pct` are absent, and the line
  every dot is read against is `cpr_line` with `cpr_line_source`
  (`owner_target` when the owner stated one, else `account_average`). No
  section prose on such an account contains the words ROAS or breakeven.
- **Enforced in the prompts.** `buildSynthSystem` carries a lens brief, so a
  synthesis on a lead-gen account is told in rules, not in context, that the
  account records no ROAS, revenue, carts or checkouts.
- **Refused where it cannot be read.** `mixed` (leads AND purchase revenue) and
  `unknown` (neither) store the sections that need ONE conversion grammar
  (`budget_scatter`, `concept_roas`) as `status: "skipped"` with a one-line
  `skip_reason`. **The report page renders nothing for a skipped section** —
  it is not an error and not a gap in the work, it is a judgment we decline to
  make on this account. Sections that read the same in either grammar (CPM
  trend, concentration, day of week, cohorts, saturation, funnel) always run.

A recognition read that FAILED leaves the lens null, and a null lens skips
nothing: "we could not read the account" is not the same claim as "the account
is ambiguous", and only the second may cost the reader a section.

## Env

| Var | Purpose |
|---|---|
| `TINKERS_BASE_URL` | Tinkers app origin (e.g. `https://gettinkers.com`) |
| `TINKERS_AUDIT_SEAM_SECRET` | Shared secret we sign seam requests with; must match the Tinkers Vercel env |

Both optional in `src/env.ts` — unset simply means the bridge path is closed
(503), exactly like `AUDIT_TRIGGER_SECRET`.

## Deploy

Set both vars in `/root/dai/.env` first (the bridge path 503s without them,
which is the honest state, not an outage), then on the droplet:

```bash
cd /root/dai && git pull --ff-only && pnpm build && systemctl restart dai
```

The restart bounces all agents (Ada/Piper/Maya/Jasmin) as usual.

## Evals

CLAUDE.md's mandatory Ada eval loop covers changes to Ada's behavior —
`agents/ada/**`, `src/agents/runner.ts`, `src/agents/registry.ts`, tool
definitions/profiles, model/thinking config. This change touches none of them:
it is a new trigger branch, a new seam module, and one optional callback in the
audit orchestrator. No prompt, tool, or model configuration moves, so the
golden-question evals are not triggered. (Considered and ruled out
deliberately — not skipped.)
