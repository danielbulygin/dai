# Media Buying Analysis — Daniel's Methodology

A comprehensive methodology for analyzing Meta/Facebook ad accounts, extracted from real media buying practice at Ads on Tap agency.

## 1. The Seven Principles

### Principle 1: Funnel-First Diagnosis
"Where in the funnel do things start breaking apart?"

Never start with surface metrics. Always trace the full funnel:
```
Impressions → Clicks → LPV → VC → ATC → IC → Purchase
```
- Find the EXACT stage where conversion drops
- Compare each stage rate against account-specific historical norms
- A CPA problem is never "just CPA" — it's a symptom of a funnel break
- Walk funnel metrics in ORDER: amount spent → frequency → hook rate → hold rate → CTR → PDP view rate → ATC rate → conversion rate → AOV
- Every metric before the breaking point might actually be improving — the breaking point IS the diagnosis
- For lead gen: Impressions → Clicks → Landing Page → Registration/Lead → Qualified Lead → Appointment → Sale

### Principle 2: Frequency is the #1 Leading Indicator
"If frequency goes above 3, start worrying. Above 4, you're burning money."

- Frequency is checked FIRST, before any other metric
- High frequency + declining performance = audience saturation (not creative fatigue)
- High frequency + stable performance = lucky streak, won't last
- Every account needs at least one ad set driving LOW-FREQUENCY FRESH REACH (the "top-of-funnel engine")
- Frequency by itself isn't bad — it's frequency WITHOUT fresh reach that kills accounts
- When the top-of-funnel engine ad set gets killed, performance drops IMMEDIATELY
- Check CUMULATIVE frequency (not just daily) for ads with massive reach — an ad with 21M views may have burned through the audience even at moderate daily frequency
- Frequency inverse correlation with ROAS is consistent across accounts — validate across multiple time windows

### Principle 3: Data Skepticism & Cross-Validation
"Never trust a single data source. Meta says one thing, Shopify says another."

- Always cross-reference: Meta Ads Manager vs Domo vs Shopify vs Google Analytics vs Triple Whale vs Salesforce vs Amplitude
- Attribution windows change everything: 1-day click vs 7-day click can show wildly different stories
- Meta's "conversions" are modeled, not always real
- When data conflicts, investigate the delta — it usually reveals the real problem
- Check if tracking/pixel is even working before analyzing metrics
- "Last 7 days" means different things on different platforms — ALWAYS use explicit date ranges when cross-referencing
- Quantify the platform discrepancy as a percentage (e.g., "Meta under-reports by ~25%") and use it as a persistent conversion factor
- Derive platform-specific targets from client targets using the discrepancy factor
- View-through attribution (1-day view) inflates numbers significantly — isolate click-only campaigns for true measurement
- When Meta and client CRM numbers diverge, the truth is usually somewhere between
- Check the API directly — Meta's Events Manager UI hides problems that the API reveals

### Principle 4: Context Before Conclusions
"Before you blame the ads, check what else changed."

External factors that override ad-level analysis:
- **Website**: Slow load times, broken checkout, price changes, out-of-stock products, Shopify issues, broken CTAs, missing booking slots
- **Market**: Seasonality, competitor activity, weather (for relevant verticals like drinks/wellness), stock market
- **Platform**: Algorithm changes, policy changes, cross-account patterns (if ALL accounts dip, it's Meta, not you)
- **Business**: Sale endings, warehouse moves, team changes, budget shifts, staffing gaps, fulfillment center transitions
- **Tracking**: Pixel changes, Elevar migration, attribution window changes, event mapping errors

Always ask: "Is this an ad problem or a business problem?"

Speed of change indicates cause:
- Sudden (1-2 days) → Account change, website issue, or algorithm shift
- Gradual (1-2 weeks) → Creative fatigue, audience saturation, or market shift

ALWAYS check other accounts before changing anything in a specific account. If 3+ accounts show the same pattern on the same day → platform issue. Response: DO NOTHING for 24-48 hours.

### Principle 5: CPM as Leading Indicator
"Check CPMs before blaming creative. If CPMs spiked, your costs went up for reasons outside your control."

- Rising CPM → Check if it's platform-wide (competition/auction pressure) or account-specific
- CPM spike + stable CTR = external cost pressure, not creative failure
- CPM drop + performance drop = you're reaching cheaper (lower-quality) audiences — this is a WARNING, not a celebration
- Device-level CPM differences (iOS vs Android) reveal audience quality dynamics
- In supplement/health verticals, certain words trigger Meta's algorithm penalty with higher CPMs
- Share industry CPM data with clients proactively when platform-wide spikes occur — "Say it's not just us"

### Principle 6: Creative Diagnosis via Hook Rate + Hold Rate
"Hook rate tells you if people stop scrolling. Hold rate tells you if they care."

- **Hook rate** (3-second video view / impression): Did the creative interrupt the scroll?
  - 30%+ = Excellent
  - 25-30% = Solid
  - 20-25% = Below average
  - <20% = Kill or rework
- **Hold rate** (ThruPlay / 3-second view): Did the content after the hook deliver?
  - Good hook + bad hold = content problem (boring middle, weak CTA)
  - Bad hook + any hold = hook problem (test new hooks first)
- Creative fatigue shows as declining hook rate over time, NOT declining CTR
- TOO-GOOD metrics should trigger suspicion — a 40% hook rate usually means Audience Network is inflating numbers. Check placement breakdown immediately.
- What makes hooks work: chaos/movement in the beginning, relatable content, showing the actual product (not just pretty lifestyle shots)
- Creative supply constrains optimization aggressiveness — you can only kill underperformers as fast as your pipeline replaces them
- 6 new videos per category per week is the target creative velocity for TikTok (also reusable on Meta)

### Principle 7: Action Bias with Kill Discipline
"If something isn't working after enough data, kill it. Don't hope."

**Kill Composite** (ALL must be true):
- Frequency > 3.5
- CPA > 5x target for 3+ days
- < 2 conversions in the period
- No external explanation found

**Scale Composite** (ALL must be true):
- Primary KPI at/below target for 3-5 consecutive days
- 5+ conversions per day
- Frequency < 2.5
- Budget headroom exists

**Pause vs Kill**:
- Pause = temporary hold, will revisit (audience saturation, seasonal dip, stock-out)
- Kill = permanent off (creative failed, audience exhausted)

**Zero performers die first**: When budget must be reduced, campaigns with zero conversions are the first cut.

**"Don't over-manage" principle**: Sometimes the best optimization is to stop forcing Meta to spend on test ads and let the algorithm allocate to proven winners.

---

## 2. Advanced Patterns

### Revenue Per Click (RPC)
Custom KPI: `Purchase Conversion Value / Outbound Clicks`
- Removes attribution modeling noise
- Directly comparable across time periods
- Rising RPC = traffic quality improving
- Falling RPC = wrong people clicking (pre-qualification issue)
- Even with lower conversion rates, if RPC is high, the traffic is valuable

### CR2 Over CPL for Lead Gen
"CR2 is basically the biggest correlator with CPA."
- CPL (cost per lead) is vanity — CR2 (downstream conversion rate) is reality
- A $50 lead that converts at 20% beats a $20 lead that converts at 2%
- Always trace leads to downstream action (call booked, sale closed, form completed)
- Create custom funnel metrics: Q1 answer rate, form completion rate
- CRITICAL INSIGHT: CPA is relative to CR2. When CR2 depends on something you don't control (like client's sales team call speed), your entire optimization framework may be compromised. Track and flag this.
- Distinguish between gross leads and net leads (qualified) — the ratio between them is a persistent conversion factor

### Bid Cap Methodology
- Start without bid cap, establish baseline CPA
- If CPA is volatile, add bid cap at 1.2-1.5x target CPA
- Slowly increase bid cap to find the sweet spot (max volume at acceptable cost)
- Lower bid cap by small increments ($0.50) to find the floor where it still spends
- Bid caps prevent Meta from overspending on low-intent users
- NEVER start a new campaign with aggressive bid caps — let it learn first
- Bid cap overspending its campaign budget = POSITIVE signal (market wants to give you conversions at that price)
- Bid cap NOT spending its daily budget → increase bids incrementally every day
- Pre-position bid caps before anticipated events (stock returning, seasonal demand) for immediate scale-up

### The Honeymoon Phase
- Fresh campaigns often outperform due to clean pixel data and algorithm exploration
- Don't celebrate early wins — wait 7-14 days for true performance signal
- Performance after day 14 is the "real" baseline
- If you keep seeing honeymoon phases, accumulated pixel data may be "polluting" — consider if duplicating ad sets to reset could be a deliberate strategy

### Active vs Passive Account Management
- **Active accounts**: Daily monitoring, multiple optimizations per week, 3+ campaigns
- **Passive accounts**: Weekly check-in, stable performers, minimal changes needed
- Misclassifying an active account as passive = wasted spend
- Classify each account and adjust monitoring cadence accordingly

### Device-Level Analysis (iOS vs Android)
- iOS vs Android performance is a FIRST-CLASS concern, not an afterthought
- iOS users typically: higher AOV, better ROAS, but attribution is worse (iOS 14.5+)
- Android users typically: higher volume, lower quality, but better trackable
- When ROAS diverges by device, investigate separately
- Apple Safari updates can cause LPV (landing page view) events to stop firing on iOS — check LPV share (LPV/Link Clicks) as a health metric
- For 65+ demographics, Android may actually be BETTER (older users tend to use Android)
- Always run device-level pivot tables: rows = device platform, values = cost per conversion + amount spent
- Consider Android-only campaigns when Android CPA is dramatically better (e.g., 6x lower)
- Device performance patterns vary by client and demographic — never assume one rule fits all

### Platform-Wide Issue Detection
"Before you change anything, check if the other accounts are doing the same thing."
- If 3+ accounts show same pattern on same day → platform issue, not account issue
- Response to platform issue: DO NOTHING. Wait 24-48 hours.
- Response to account issue: Investigate and act
- Share industry data with clients proactively to contextualize platform-wide issues

### The Duplicate-to-Reset Strategy
When frequency is high and performance declines:
- Duplicate the entire ad set to get a fresh ad ID and reset delivery
- Same ad, new ad ID — Meta's algorithm treats it as a fresh entity
- This works because Meta's delivery algorithm can "exhaust" an audience even with new creatives

### ROAS vs Absolute Profitability
- High ROAS at low spend can still be unprofitable (fixed costs exceed margin)
- ROAS compression at higher spend is normal and acceptable if absolute profit improves
- Formula: Profitability = (ROAS x Spend) - Fixed Costs
- Some clients need 3x their current spend just to cover operating costs at current ROAS
- "Even ROAS is down because of the spend that is so high" — this is okay if the business is moving toward profitability

### AOV as a Lever
- When conversion rates are fine but ROAS is low, the problem is AOV, not the ads
- Push traffic to bundle pages instead of single-product PDPs to increase AOV
- This is a landing page/product problem, not a media buying problem
- A/B test collection pages vs PDPs to find the highest-AOV destination

### New Customer vs Existing Customer Segmentation
- Use Meta's audience segment breakdown (not just new customer acquisition goal) because Meta sometimes targets existing customers even with new customer optimization
- "We aren't actually distinguishing between new and old customers in campaigns but rather we are instructing Meta to go after new customers. But sometimes it goes after old ones as well."
- Existing customers having LOWER ROAS than new customers is a red flag worth investigating
- For e-commerce, blended CPA/ROAS is insufficient — always segment by new vs returning

### Client-Communicated Targets May Be Artificial
- Verify KPI targets independently when possible
- Clients may give artificially low targets to keep the agency performing above expectations
- Knowing the real target changes the entire optimization strategy

### Account Structure Simplicity
- "A million campaigns" is a red flag — too many campaigns dilutes learning and budget
- One ad set with 30 ads is "pretty much useless" — Meta can't distribute budget effectively
- Consolidate winners into CBO structures
- Test broad targeting before over-segmenting (some accounts have never tested broad!)
- CBO with minimum spend per ad set = both testing and scaling in one campaign

---

## 3. Diagnostic Pattern Library

### Pre-Click Patterns
| Pattern | Diagnosis | Action |
|---------|-----------|--------|
| High CTR + Low CVR | Pre-qualification issue — wrong people clicking | Tighten hook messaging, add qualifiers |
| Good hook rate + bad hold rate | Content after hook not engaging | Rework body content, keep hook |
| Bad hook rate + any hold rate | Hook problem | Test new hooks on same concept |
| Social profile CTR spike | Traffic going to IG instead of website | Check Audience Network, exclude if needed |
| Too-good metrics (40%+ hook rate) | Audience Network inflating | Check placement breakdown immediately |
| CPM spike + stable CTR | External auction pressure | Wait, inform client, check if platform-wide |
| CPM drop + performance drop | Reaching cheaper/lower-quality audiences | Investigate audience targeting |
| High impressions + low reach | Same people seeing ad repeatedly | Frequency issue, need new audiences |
| Declining hook rate over time | Creative fatigue (not audience fatigue) | New creative needed |

### Post-Click Patterns
| Pattern | Diagnosis | Action |
|---------|-----------|--------|
| High PDP view rate + high cart abandonment | Checkout/pricing problem | Investigate checkout flow, pricing |
| ATC rate drop + stable everything above | Landing page/pricing change | Check for sale ending, price changes, stock-outs |
| LPV rate dropping | Page speed issue or tracking break | Check load times, pixel firing |
| Conversion rate collapse (2.6% to 0.6%) with stable ad metrics | Post-click funnel broken | Walk the entire funnel manually |
| Funnel break at ATC | Pricing/product page problem | Check prices, stock, product presentation |
| Funnel break at IC | Checkout friction | Check checkout flow, payment methods, shipping |
| Revenue per click declining | Pre-qualification issue in ads | Tighten targeting/messaging |

### Account-Level Patterns
| Pattern | Diagnosis | Action |
|---------|-----------|--------|
| Frequency > 3.5 + declining ROAS | Audience saturation | Need fresh TOF creative + new audiences |
| All accounts dipping same day | Platform-wide issue | Do NOTHING for 24-48 hours |
| New campaign outperforming established | Honeymoon phase | Wait 14 days for real baseline |
| Frequency < 1.5 + low spend | Audience too narrow | Broaden targeting |
| Bid cap overspending | Strong market signal | Consider lowering cap to find sweet spot |
| Bid cap not spending | Price too low for market | Increase bids incrementally |
| iOS ROAS >> Android ROAS | Premium audience correlation | May be normal, but check attribution |
| Retargeting CPA > Prospecting CPA | Retargeting setup broken | Investigate retargeting campaign structure |
| CPA volatile day-to-day | Needs bid cap | Add bid cap at 1.2-1.5x target |
| Stock-out + performance drop | Not an ad problem | Reduce spend, wait for restock |
| Sale ended + ATC drop | Deal sensitivity, not price sensitivity | Plan next promotional window |

---

## 4. Metric Quick Reference

### Calculated Metrics
| Metric | Formula | What It Reveals |
|--------|---------|-----------------|
| Hook Rate | 3-second video views / Impressions | Scroll-stopping power |
| Hold Rate | ThruPlays / 3-second video views | Content engagement after hook |
| CTR (Link) | Link clicks / Impressions | Ad-to-click efficiency |
| PDP View Rate | Product detail page views / Link clicks | Landing page engagement |
| ATC Rate | Add to carts / PDP views | Product interest conversion |
| ATC Rate (from clicks) | Add to carts / Link clicks | Full post-click conversion |
| Checkout Rate | Checkouts initiated / Add to carts | Checkout friction measure |
| Purchase Rate | Purchases / Checkouts initiated | Payment completion rate |
| ROAS | Purchase value / Spend | Return on ad spend |
| CPA | Spend / Conversions | Cost per acquisition |
| AOV | Purchase value / Purchases | Average order value |
| Revenue Per Click | Purchase value / Outbound clicks | Traffic quality (attribution-independent) |
| LPV Share | Landing page views / Link clicks | Tracking health indicator |
| Net CPL | Spend / Net leads (qualified) | True cost per qualified lead |
| CR2 | Appointments / Leads | Downstream conversion quality |

### Key Benchmarks (Account-Specific Always Override)
| Metric | Excellent | Solid | Watch | Concern | Critical |
|--------|-----------|-------|-------|---------|----------|
| Hook Rate | 30%+ | 25-30% | 20-25% | 15-20% | <15% |
| Frequency (7-day) | <1.5 | 1.5-2.5 | 2.5-3.5 | 3.5-4.5 | >4.5 |
| CTR (Link) | >2% | 1.5-2% | 1-1.5% | 0.5-1% | <0.5% |

---

## 5. External Context Checklist

Before making ANY optimization change, check:

### Website/Funnel
- [ ] Is the landing page loading correctly? (visit it yourself)
- [ ] Is the checkout process working? (walk through it)
- [ ] Did prices change?
- [ ] Are products in stock?
- [ ] Did the client change anything on their site?
- [ ] Are booking slots available? (for lead gen with Calendly/booking)
- [ ] Is the pixel firing correctly at each funnel stage?
- [ ] Did an A/B test start or end on the site?

### Platform
- [ ] Are other accounts showing the same pattern?
- [ ] Did Meta make any known algorithm/policy changes?
- [ ] Is there an industry-wide CPM spike?
- [ ] Did Apple release a software update? (check LPV share on iOS)

### Business
- [ ] Did a sale/promotion start or end?
- [ ] Are there seasonal factors? (January = health month, weather for drinks brands)
- [ ] Did the client's team change? (new account manager, staff layoffs)
- [ ] Is the warehouse/fulfillment operating normally?
- [ ] Did the client change their pricing/offer?

### Market
- [ ] What's the weather doing? (for weather-sensitive verticals)
- [ ] Is a competitor running a major campaign?
- [ ] Are there macroeconomic factors? (recession fears, consumer confidence)

---

## 6. Account Classification

### Active Accounts
- Daily monitoring required
- Multiple optimizations per week
- 3+ campaigns running
- Budget > threshold for meaningful data
- Performance volatile or scaling

### Passive Accounts
- Weekly check-in sufficient
- Stable performers with consistent ROAS/CPA
- Minimal changes needed
- Bid caps doing the heavy lifting
- "Set and optimize" mode

### Classification Criteria
| Signal | Active | Passive |
|--------|--------|---------|
| Budget changes this week | Yes | No |
| New creative launched | Yes | No |
| Performance deviation >15% | Yes | No |
| Client requesting changes | Yes | No |
| Frequency trending up | Yes | No |
| Scaling in progress | Yes | No |

---

## 7. Client Communication Templates

### Flagging a Performance Issue
"We are currently investigating [metric] changes for [product/campaign]. What we've discovered is that since [date] compared to [comparison period], [specific metric] has [changed by X%]. [List what we've ruled out]. Do you have any ideas of what could have caused this? Because [evidence of what's working]."

### Sharing a Kill/Scale Decision
"Based on [X days] of data, we're recommending to [kill/scale/pause] [campaign/ad set]. Here's why: [specific metrics]. Expected impact: [what should happen]. We'll review again in [timeframe]."

### Platform-Wide Issue Communication
"We're seeing [pattern] across multiple accounts today, which suggests this is a platform-level shift rather than anything account-specific. We recommend holding steady for 24-48 hours before making changes. We'll monitor closely and update you."

### Proactive Budget Reallocation
"We'd like to reallocate budget from [category A] to [category B] based on [efficiency data]. This means [trade-off explanation]. Would you be comfortable with this approach?"
