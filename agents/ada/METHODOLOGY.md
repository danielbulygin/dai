# Ada's Analysis Methodology

This is your analysis playbook — built from 6,469 extracted rules, insights, decisions, creative patterns, and methodology steps from Daniel and Nina's meeting transcripts.

---

## The Analysis Framework

### Level 1: Account Health Check (run first, every time)

Before any deep analysis, assess these five indicators:

1. **Spend pacing** — actual vs target budget. <70% = missed opportunity (P1). >130% = overspend alert. >150% = P0 emergency.
2. **Primary KPI trend** — last 3 days vs 7-day avg. Use the trailing 3-day window as your decision-making timeframe.
3. **Frequency** — current vs 7-day avg vs 14-day avg. >3.0 = warning, >3.5 = kill territory. Check cumulative frequency for saturation: flat line = reaching new people, upward curve = audience exhausted. Important signal but not always the main issue.
4. **Active campaign count** — anything paused unexpectedly? Any campaigns stuck in learning phase?
5. **Recent changes** — check `get_account_changes` for anything modified in last 48h. Budget changes, new ads, status changes — any of these could explain performance shifts.

If all five are green, the account is healthy. Report and move on. If any flag, proceed to Level 2.

### Level 2: Funnel Diagnosis (when KPI is off target)

Trace each funnel stage. Find the EXACT breaking point. Walk metrics IN ORDER — the first stage that breaks IS the diagnosis:

| Stage | Metric | What a Drop Means |
|-------|--------|-------------------|
| Impressions | CPM, reach | CPM pressure, audience too narrow, budget cap hit |
| Clicks | CTR (link) | Creative fatigue, audience saturation, wrong placement mix |
| Landing Page Views | LPV rate (LPV / link clicks) | Page load issues — check device breakdown |
| Content Views | PDP view rate (content_views / link_clicks) | Landing page UX problem, traffic relevance issue. Target: 60-80% |
| Add to Carts | ATC rate (ATC / content_views) | Out of stock, price change, page UX. Target: 5-15%. Below 3-4% = landing page or traffic relevance problem |
| Checkouts | Checkout rate (IC / ATC) | Payment issues, shipping costs, promo code problems. 40-70% typical |
| Purchases | Conversion rate (purchases / link_clicks) | Attribution issues, competitor undercutting, checkout friction |

**For each stage, compare:**
- Current rate vs account's own 7-day average (primary)
- Current rate vs account historical baseline (secondary)
- Current rate vs benchmark (tertiary — every account is different)
- Direction: improving, declining, or stable

**Lead gen / app install accounts:** The funnel is shorter — Impressions → Clicks → LPV → Lead/Registration. ATC, checkout, and purchase metrics will be zero. That's expected, not an anomaly.

### Level 3: Root Cause Investigation (Four Forces)

When you've identified WHERE the funnel breaks, determine WHY using the Four Forces:

**1. You (Media Buyer Changes)**
- Check `get_account_changes` for last 7 days
- Budget changes? New creatives launched? Ad sets paused? Targeting modified? Bid cap adjustments?
- Speed check: if the change was sudden (1-2 days), correlate with change timestamps
- Scaling degradation: if budget increased >30% in last 3 days AND CPA rising AND frequency rising → algorithm pushed into less efficient segments. Revert or slow down.

**2. Destination (Website/Landing Page)**
- Landing page down or slow? Check LPV rate for device-specific drops
- Price change or out-of-stock? ATC rate drops >40% vs 7-day avg with stable CTR and traffic = likely stock issue
- Checkout friction? ATC rate stable but checkout rate drops >30% = payment/shipping/promo problem
- A/B test running? Could be suppressing conversion rate on one variant
- Landing pages are the highest-impact lever for improving conversion performance. A bad page kills good ads.

**3. Platform (Meta)**
- Cross-account check: if 3+ accounts show the same metric dip on the same day → it's Meta. Do nothing for 24-48h.
- Check for policy changes, algorithm updates, iOS signal issues
- Attribution window shifts: ROAS drops but conversion volume and CPA stable → likely attribution model change, not real performance decline

**4. Market (External)**
- Seasonality patterns (Laori peaks in December for dry January; BFCM changes everything)
- Competitor launches, new entrants
- Economic conditions, weather (for relevant verticals)
- Cheap CPMs from certain geos (e.g., Dubai) can tank lead quality — Meta over-serves to cheapest audiences if not excluded

### Level 4: Creative Deep Dive (when creative is the issue)

Only reach this level after ruling out audience, placement, frequency, and platform issues at Level 3.

**1. Hook Rate Analysis**
- Sort all active ads by hook rate (video_p25 / impressions)
- Benchmark: 20-30% is good, 30%+ is excellent, 40%+ is exceptional ("sick")
- ~0.3% = creative is fundamentally failing to capture attention — replace immediately
- Hook rate declining over 7+ days on same creative = fatigue signal

**2. Hold Rate Analysis**
- Hold rate = video_avg_time / video_duration (or ThruPlay / 3s views)
- Good hook + bad hold = body content problem, not hook problem. The post-hook substance isn't delivering.
- 60-80% drop-off from hook to completion is normal

**3. Fatigue Detection**
- Check: frequency + days running + hook rate trend + `is_fatigued` flag
- If same creatives running >14 days AND frequency >3.0 AND CTR declining AND hook rate declining → creative fatigue confirmed
- When a single ad generates all purchases in an ad set = creative dependency risk

**4. Format Analysis**
- UGC with physical demo/gesture can dramatically outperform — visual proof of product benefit is key
- Statics are faster to produce than video and should be tested first for quick bottom-of-funnel wins
- 9:16 croppable to 4:5 is the ideal format — works across all placements
- Founder/client-as-talent UGC can be extremely strong and hard to beat with new creative

**5. Traffic Relevance Check**
- Funny/entertaining hooks driving high engagement but low ATC/conversion = wrong audience. The hook attracts clicks from people who'll never buy.
- High CTR (>5%) + low conversion + Audience Network >20% of spend = placement leakage
- Social profile CTR (people going to IG instead of website) = audience network issue

---

## Decision Composites

### Kill (ALL must be true)
- Frequency > 3.5
- CPA > 5x target for 3+ consecutive days
- < 2 conversions in the period
- No external explanation found (checked all Four Forces)

Kill decisively. No emotional attachment. Even former top performers get killed when the data says so — "Kill high-spending ads that produce minimal conversions, even if they were previous top performers."

### Scale (ALL must be true)
- Primary KPI at/below target for 3-5 consecutive days
- 5+ conversions per day (statistical significance)
- Frequency < 2.5 (headroom for growth)
- Budget headroom exists

Scale in 20% budget increments. Don't make large jumps — increase $5-$20/day across multiple days, monitoring CPA stability between increases. "When CPA is below the client's target threshold, increase spend aggressively — push, push, push."

### Pause (temporary — specific conditions required)
- External factor identified (website down, out of stock, seasonal dip, booking slots full)
- Expectation that the issue is temporary
- Define specific revisit conditions and date: "Resume when stock is back" or "Check again Monday"

### Iterate (targeted improvement)
- Hook rate < 25% → test new hooks on the same body. Hook-swapping is the fastest test — isolates the variable.
- Good hooks, low conversion → body content and offer presentation need work, not the hook
- High CPA, decent volume → try bid cap at 1.2-1.5x target CPA, or use cost caps in CBO
- Creative fatiguing (hook rate declining over 7 days) → new creative needed. Flag to production team.
- Straightforward, product-focused creative often outperforms humorous/entertainment content for direct response
- When entertainment hooks drive clicks but not conversions → pivot to direct, business-focused hooks

### Restructure (account-level changes)
- Excessive campaign fragmentation at low spend destroys performance → consolidate first
- For accounts under $50K/month: one testing campaign (ABO/CBO) + one scaling campaign (ASC/CBO)
- Campaign duplication to replace degrading campaigns can reignite performance — forces Meta to re-explore audiences
- Separate scaling and testing campaigns with different budget rules: scale gets increases when CPA hits target, testing holds or reduces when CPA rises

---

## Campaign Structure Principles

### Testing
- Use ABO or CBO with minimum spend per ad set for creative testing — gives all assets equal chance
- Use an "ads bank" campaign (always off) to organize all creatives before deploying. Enabled ads in bank = untested.
- Limit pace: 1-2 new ad sets per week when legacy performers still dominate spend
- Don't scatter limited budget across too many active ads — consolidate for meaningful testing
- Once an ad set has enough spend, score it (good/bad/average) and diagnose: hook rate → CTR → conversion rate

### Scaling
- Promote winners from CBO to ASC using post ID to preserve social proof
- Add proven winning creatives/creators to scaling campaigns, not testing campaigns
- When a winning creative is found, report WHY it works and recommend more of that direction
- Account structure should evolve as spend scales — methods at $10K/month don't work at $100K+

### Naming & Tracking
- Naming conventions with unique identifiers on every ad — non-negotiable for creative analysis
- UTM parameters (source/medium/campaign) on all campaigns with multiple traffic sources
- Track UTM parameters through to lead quality, not just CPL
- Audit for duplicate ads that waste budget without contributing to learning

---

## Per-Account Pattern Library

These patterns are extracted from real account data and meeting transcripts. Always check account-specific knowledge before applying generic rules.

### Brain.fm
- 7-day trial model, not direct purchase — CPL and trial-to-subscription rate are the key metrics
- CPA target: under $30. Under $20 is great during BFCM; $15 is exceptional; $25 triggers reassessment
- The oldest ad is often the best performer due to accumulated social proof (thousands of likes, positive comments)
- CBO subscription campaign is the top-performing structure
- Female-audience UGC can underperform vs proven creatives — audience-creative fit needs iteration
- Previous top-performer video ads can decay and start spending heavily with minimal conversions — monitor and be willing to kill
- Followers are excluded from both prospecting and retargeting — they never see ads
- Scale: when trailing 3-day CPA drops below target, increase budget by 20%

### Laori
- ~50% of Shopify revenue is driven by Meta — dominant paid channel
- The 1, 3, and 6 bottle set format outperforms alternative bundles
- Introducing an ultimate bundle at ~800-900 EUR caused 50% of revenue to come from that bundle and roughly doubled AOV without proportional conversion rate drop
- Seasonal: peaks in December for dry January prep
- Naming convention with Boris: "Mix" label = ad set contains multiple product types

### Audibene
- Booked appointments aren't passed back to Meta as custom events — limits platform optimization
- CR3 (appointment to sale) is unknown due to long sales cycle — cohort analysis needed
- Android users deliver lower CPL than iOS. After iOS changes, LPV share dropped significantly for iOS
- Pixel flagged as health and wellness by Meta — restricts PII parameters, lookalike audiences, and retargeting
- Net lead event exists but event match quality is poor; website matching is enabled

### JVA
- Three campaign types: general training system, Bahamas event promotion, webinar promotion
- UK webinars: 436 signups in 7 days at £6.34 CPL
- US and UK need separate campaigns — soccer/football terminology difference requires different creative
- Budget target: £15,000/month (£500/day), starting at £50/day until everything is in place

### Germanikure
- One dominant ad consumed all purchases then fatigued — CPA rose when it was turned off (creative dependency risk)
- Budget decreased when CPA exceeded target to maintain efficiency while awaiting new creative
- Structure: separate scaling campaign for best performers, testing campaign running in parallel
- Second batch of creative assets performed significantly worse than first batch ("total winner") — new assets being tested

### Slumber
- Founder/client-as-talent UGC-style ads are extremely strong and hard to beat with new creative
- Straightforward, product-focused, clinical-looking creative outperforms humorous/entertainment content
- Regulated product (sleep/melatonin) — creative and landing pages must avoid restricted terms entirely
- Strategy: evaluate new ad sets against existing performers in CBO/ASC; kill non-performers, cycle in from ads bank

### AoT Academy (Agency's own)
- Treat own ad account with same rigor as client accounts — it's the business card
- Sneaker-themed creative achieved $5 CPL — unexpected concepts can outperform on-the-nose industry creative
- Hook rates of 41-45% = exceptional performance, correlating with $11/lead CPAs
- Straight-to-the-point business hooks ("Is lead generation a problem?") produce higher-quality leads than funny hooks
- Pre-qualifying language in hooks (referencing ad spend thresholds) filters audience quality before the click
- Currency mismatch fix: migrated from GBP to USD account, eliminating 3% international processing fees. Combined with new creative, CPL dropped from ~$60 to $11
- Pause ads when no booking slots available — don't waste budget on leads that can't be served

---

## Global Rules

Proven principles that apply across all accounts.

### Data & Tracking
- Tracking and attribution setup is the first priority when taking over any account
- Naming conventions must be established before any analysis can begin
- Always verify pixel, Conversion API, and all tracking parameters are properly firing before scaling spend
- Use GA4 as a cross-platform view to understand Meta's share of overall revenue
- Revenue per site visitor is a better A/B test metric than conversion rate alone

### Account Structure
- Excessive campaign fragmentation at low spend destroys performance — consolidate first
- For accounts under $50K/month: testing campaign + scaling campaign. Keep it simple.
- CBO with minimum spend per ad set functions similarly to ABO for creative testing
- Separate best-performing ads into a dedicated scaling campaign while continuing to test in a testing campaign
- When adding new geos, monitor budget allocation closely — new geos can cannibalize spend from better-performing locations

### Budget & Scaling
- Scale budgets by 20% increments when trailing metrics are at or below target CPA
- Increase incrementally ($5-$20/day) rather than in large jumps
- When CPA rises above target, reduce budget rather than continuing to spend at unprofitable levels
- A monthly budget should support approximately 50 conversion events per week based on expected CPA

### Creative Strategy
- Creative production must be strategy-driven, not volume-driven — each creative needs a clear hypothesis
- Test hooks first while keeping the body the same — isolates the variable
- Creative strategy should hit people from different angles, not just iterate on one winner
- Start creative testing with best-selling products first
- Don't overlook statics and carousels — they can outperform video for some accounts
- When existing humorous creative isn't performing, pivot to straightforward, product-focused direct response before iterating on more entertainment angles
- Ad longevity in competitor ad libraries is a strong proxy for ad success — use competitive research

### Audience & Targeting
- Use cumulative frequency to diagnose audience saturation — flat line = new reach, upward curve = exhausted
- Check for audience overlap and exclusion issues when auditing accounts
- Cheap CPMs from certain geos can tank lead quality — Meta over-serves to cheapest audiences
- Try more segmented audiences when performance plateaus on broad
- International expansion typically requires ~3 weeks for meaningful signals

### Lead Generation Specific
- Track UTM parameters through to lead quality, not just CPL
- Use qualifying questions in lead forms to filter quality before evaluating campaign performance
- Funny/entertaining hooks increase lead volume but decrease lead quality
- Pre-qualifying language in hooks filters out low-value leads before the click
- When lead quality drops, check geo breakdown and the specific creative driving the leads

### Client Management
- Understand the client's broader business context, not just their target CPA
- Work with clients to calculate true unit economics and set CPA targets based on internal conversion rates
- Report on learnings (what worked, what hasn't, and why) rather than raw metrics like CPC or impressions
- Generate wins before arranging client calls — demonstrate value first

### Landing Pages & Destination
- Landing pages are the highest-impact lever for improving conversion performance
- Testimonial-heavy landing pages outperform other variants for conversion
- A/B test landing pages using external tools (VWO), not Meta's native A/B test
- When funnel over-constrains product selection, sending users to a collection can lift AOV and make higher CPAs survivable
- Exit intent pop-ups provide ~5% boost at best — good to have but not transformative
