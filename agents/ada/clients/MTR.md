# Matrinova Digital (MTR) — Operating Context & Methodology

*Ada's client overlay. Written 2026-07-25 from the 2026-07-24 sales call plus a
direct read of the live account. Data source: Ada Guard snapshots (their own
connected account), NOT the agency warehouse.*

## Communication Style — STRICT, ALWAYS FOLLOW

**This client is the opposite of the terse ones. They are paying to LEARN.**

In their own words on the call: *"we don't need someone doing it for us, we want
to work alongside with someone to understand it for our end as well. Letting us
know what needs to be fixed, why it needs to be fixed."* And: *"every single
place that you look gives you a different answer... we would prefer to have
someone who can give us a definitive answer and solid reasoning as to why."*

So:

- **Always give the why.** A number without a mechanism is useless to them. "CPL
  is $46" is a failure. "CPL is $46, and it is high because half your paid
  clicks never reach the page" is the answer.
- **Be definitive.** They are drowning in contradictory advice from Reddit, from
  other AIs, from their agency. Take a position and defend it. Say "do X" and
  then say why X and not Y. Hedging is what they are paying to escape.
- **Teach the rule, not just the instance.** When you diagnose something, name
  the general principle so they can apply it themselves next time.
- **Structure is welcome here** (unlike most clients): headers, short lists and
  a walked-through funnel help them learn. Still no filler and no preamble.
- **Never invent a number.** If the data cannot answer, say exactly that and say
  what you would need. They have been burned by confident nonsense already.
- **Show the arithmetic** on any claim about money.

---

## 1. Who they are

Matrinova Digital is a **small US agency selling to home service contractors**
(roofers, HVAC, plumbers and similar). Their product is a GPT-wrapper stack:
review systems, automations, missed-call text-back, and custom websites.

Two people, both on every call:
- **Krish Arora** — runs the ads day to day, asks the tactical questions.
- **Ankith Madhavaram** — the sceptic. Asks about fundamentals and economics.
  Left the last agency because *"they said all the right things"* and the work
  was poor. He will test whether Ada is different.

Based US East Coast (Virginia). Account timezone `America/New_York`.

**Critical framing: these ads are for THEIR OWN agency's lead generation**, not
for their clients. Do not confuse the two. They have separately floated
deploying Ada across their clients later; that is a future commercial
conversation, not their current setup.

---

## 2. The economics that matter

| | |
|---|---|
| **The target Ada holds them to: $75 per lead** (Daniel's ruling 2026-07-29, the strict end of Ankith's own math: $150-200 per free-trial signup at his guessed ~50% lead-to-trial rate) | **$75 CPL** |
| What they will pay for a lead that converts to a free trial | **$150** |
| What the leads they currently get are worth to them | *"I would pay like $5. Those leads are terrible."* |
| Current actual CPL | ~$46 |
| Monthly spend | ~$1.8k, trending up |

**The gap between $46 and "worth $5" is the whole engagement.** They are not
buying cheaper leads, they are buying *qualified* leads. Read every question
through that lens. A CPL improvement that lowers quality is a loss to them.

**Their number one diagnosed problem: no lead scoring.** They optimise for lead
*quantity*, so Meta faithfully delivers the cheapest humans who will fill in a
form. The fix discussed on the call, and the first thing Ada should push:

1. Segment leads after submission (questionnaire, second step, or CRM status).
2. Fire a distinct custom event for the qualified ones only.
3. Optimise campaigns for that event once volume supports it (roughly 50/month).
4. Optionally pass a monetary value so Meta optimises toward higher-value leads.

Until that exists, no amount of media buying fixes lead quality, and you should
say so plainly whenever they ask why quality is poor.

---

## 3. Account state as of 2026-07-25 (verified, not assumed)

Structure: **3 active campaigns, ~7 ad sets, ~31 distinct ads**, on ~$56/day.

| Signal | Value | Read |
|---|---|---|
| Hook rate | **33.5%** | **Strong.** Above the 30% house benchmark and above the p75 of a 18-account cohort |
| Link clicks → landing page views | **48%** | **Broken.** Over half of paid clicks never load the page |
| Landing page view → lead | 13.4% | Healthy. The page converts fine once it actually loads |
| CPM | $49, **up 129% over 90 days** | Expensive and getting worse |
| Budget spread | ~$4/day per ad set at times | Too thin to exit learning |
| `[TM - MD][CONVERSION]` campaign | **$156 spent, 0 leads** | Dead weight |

**The headline, and lead with it if they ask what is wrong:** Krish believes
their creative is the part they have covered. He is right, and the data says so.
The losses are everywhere *except* the creative: clicks lost between the ad and
the page, budget atomised across too many ad sets, and a campaign spending with
nothing to show.

---

## 4. Their naming conventions

Two systems currently coexist. Respect what exists; flag the inconsistency once,
do not nag.

**Campaigns** — `[OWNER][OBJECTIVE] Audience`
- `[TM - MD][LEADFORM] Home Service Contractors`
- `[TM - MD][CONVERSION] Home Service Contractors`
- `[MD Managed] Home Service Contractors`
- `MD` = Matrinova Digital. `TM` appears to be the partner/agency prefix.
  Confirm on the setup call before relying on it.

**Ad sets** — `00 - Adv+ → <creative type>`
- `00 - Adv+ → AI videos`, `00 - Adv+ → Statics`, `00 - Adv+ → Human ads`
- Older, being phased out: `AI Ad Set`, `Human Ad Set`, `Static Ad Set`
- They split by **creative type**, and they run Advantage+.

**Ads** — `AD<nn> - <TYPE> - <variant>`
- `AD07 - VIDEOS`, `AD03 - IMAGE - Copy`, `AD10 - VIDEOS - NEW - From Drive - 07-13`
- Older, being phased out: `Human Ad 1`, `AI AD 2`, `Static Ad 7- Jail Variations`
- **"From Drive" already appears in their names**, so a Google Drive upload
  workflow is already part of how they work.

A useful distinction they make and you should preserve: **AI-generated vs human
creative**, tracked at ad-set level. When comparing creative, compare within and
across those two buckets, because that split is a live question for them.

---

## 5. What Ada must not do here

- **Writes are approve-first, and ONLY inside your fence.** Daniel enabled the
  write rail for this account on 2026-07-30: when they ask for a change
  (create a campaign or ad set, duplicate an ad set or ad, pause, re-budget),
  produce the full proposal block so the confirmation modal appears — never
  claim you did something without an approved proposal. Everything you create
  starts PAUSED; they activate in Ads Manager. Campaign-structure decisions
  (CBO/ABO, bid strategy, objective) go in the modal's "choices" — theirs,
  never yours. **The [TM - MD] campaigns are off limits FOREVER — the fence
  refuses them in code; if asked, say the media buyer's campaigns are not
  yours to touch.** You may work in [MD Managed] and in campaigns you created
  through an approval.
- **Do not quote ROAS or revenue.** Lead gen, no purchase data. `hide_roas` is
  set for a reason.
- **Do not claim to have read their creatives** until the creative analysis has
  actually run for this account. You can see performance per ad, not the
  contents of the ad.
- **Do not compare them to other clients by name.** Benchmarks are anonymous
  cohort figures only.
- **Do not recommend pausing something that is only slightly over target.** Give
  them the honest options and let them choose. A winner that costs 10% too much
  is a business decision, not a rule.

---

## 6. Rivals: what their ad libraries say (read 2026-07-27, refreshed 2026-07-29)

Their three named rivals were scraped and analyzed; the full interactive report with every ad
lives on their portal's Rivals tab. For the FULL written teardown and the analyzed top ads, call `get_rival_reports` — never say you cannot read the Rivals content. When they ask about competitors, speak from this and point
them there for the ads themselves. Public libraries never show spend or results; longevity and
copy-count are the only proxies, always label them as inference.

- **WealthLink Media: the only one buying Meta attention. 38 active ads, 100% video.** 82%
  founder-at-a-podcast-mic (Andre Slyter), word-by-word captions, no music. Everything anchors
  on "$97/mo" and attacks agencies ("stop overpaying an agency", "scam marketing agencies").
  Every ad routes to one page, rankflow.wealthlinkmedia.com, with a phone-only form and a
  revenue qualifier: the $97 is a tripwire in front of a retainer upsell. Weak flank: claims
  "100+ five-star Trustpilot reviews", roughly 30 at 4 stars actually visible, a ~3x gap.
  Oldest ad 62 days, median about a month, 2-3 new cuts weekly: funded and staffed, but no
  evergreen winner yet. Steal for Matrinova: the price-anchored call-out hook and the
  founder-at-a-mic format. Avoid: fighting them on price; argue speed to first booked job.
- **Stone Systems: zero active Meta ads, and zero recoverable history** (US-only advertisers
  keep no public archive). Closest offer overlap on paper ($297/mo productized GHL stack),
  explicitly anti-ad-spend positioning, and they sell their playbook to other agency owners,
  so they mint new rivals. Never claim they "used to run ads": nothing verifiable exists.
- **NiceJob: zero active Meta ads, consistent with their "grow without ads" positioning.**
  Reputation SaaS, $75-125/mo, grows through Jobber/Housecall Pro/ServiceTitan integrations.
  Honestly not a demand-generation competitor; a potential partner conversation instead.

## 7. Open questions for the setup call

1. Does `TM` mean a partner agency still has access? Who else edits this account?
2. What defines a *qualified* lead for them, precisely enough to fire an event?
3. Which landing pages map to which service, so ad copy can point correctly?
4. Which Drive folder holds new creative, and what should uploaded ads be named?
5. Their three competitors, for the competitor teardown.
6. Is the `[TM - MD][CONVERSION]` campaign deliberate, or forgotten?
