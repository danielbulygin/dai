# Diagnostic Pattern Quick Reference

Fast-lookup table for Ada. When you see a pattern, match it here for immediate diagnosis and action.

---

## Pre-Click Patterns

| # | Pattern | Diagnosis | Action |
|---|---------|-----------|--------|
| 1 | High CTR + Low CVR | Wrong people clicking (pre-qualification issue) | Tighten hook messaging, add qualifiers |
| 2 | Good hook + bad hold | Content after hook not engaging | Rework body, keep hook |
| 3 | Bad hook + any hold | Hook failing | Test new hooks on same concept |
| 4 | Social profile CTR spike | Traffic to IG not website | Check/exclude Audience Network |
| 5 | 40%+ hook rate | Audience Network inflating metrics | Check placement breakdown NOW |
| 6 | CPM spike + stable CTR | External auction pressure | Wait, check if platform-wide |
| 7 | CPM drop + perf drop | Cheaper/lower-quality audiences | Investigate targeting |
| 8 | High impressions + low reach | Frequency problem | Need new audiences |
| 9 | Declining hook rate over time | Creative fatigue | New creative needed |
| 10 | CTR "a little low for statics" | Static creative not popping | Make visuals more attention-grabbing |

## Post-Click Patterns

| # | Pattern | Diagnosis | Action |
|---|---------|-----------|--------|
| 11 | High PDP views + high cart abandonment | Checkout/pricing problem | Investigate checkout flow |
| 12 | ATC drop + everything above stable | Sale ended or price change | Check for promotion timing |
| 13 | LPV rate dropping | Page speed or tracking break | Check load times, pixel |
| 14 | CVR collapse with stable ad metrics | Post-click funnel broken | Walk funnel manually |
| 15 | ATC drop + 40% conversion drop | Funnel break at product page | Check prices, stock, page content |
| 16 | Checkout abandonment tripled | Checkout flow issue | Check payment, shipping, form |
| 17 | Revenue per click declining | Wrong people or wrong page | Check pre-qual and landing page |
| 18 | 2x ATC rate but 0.5x PDP view rate | Different landing page destinations | Verify traffic routing |

## Account-Level Patterns

| # | Pattern | Diagnosis | Action |
|---|---------|-----------|--------|
| 19 | Freq > 3.5 + declining ROAS | Audience saturation | Fresh TOF creative + audiences |
| 20 | 3+ accounts dipping same day | Platform-wide issue | DO NOTHING 24-48 hours |
| 21 | New campaign beating established | Honeymoon phase | Wait 14 days for baseline |
| 22 | Freq < 1.5 + low spend | Audience too narrow | Broaden targeting |
| 23 | Bid cap overspending | Strong market signal | Lower cap to find sweet spot |
| 24 | Bid cap not spending | Price below market | Raise bids incrementally |
| 25 | iOS ROAS >> Android ROAS | Premium audience + attribution gap | Check by vertical |
| 26 | Retargeting CPA > Prospecting | Retargeting broken | Investigate setup |
| 27 | CPA volatile day-to-day | Needs cost control | Add bid cap at 1.2-1.5x |
| 28 | Stock-out + perf drop | Not an ad problem | Reduce spend, wait |
| 29 | Sale ended + ATC drop | Deal sensitivity | Plan next promo window |
| 30 | TOF engine killed + immediate drop | Lost fresh reach | Restore or replace TOF ad set |
| 31 | High ROAS + low absolute profit | Volume too low for fixed costs | Scale spend (profitability = ROAS × spend - costs) |
| 32 | "A million campaigns" | Budget dilution | Consolidate into CBOs |
| 33 | One ad carrying entire account | Single point of failure | Urgent: need creative pipeline |
| 34 | Naming convention changed mid-flight | Reporting tool splits data | Never rename active ad sets |
| 35 | Android CPA 6x lower than iOS | Device targeting opportunity | Test Android-only campaign |

## Lead Gen-Specific Patterns

| # | Pattern | Diagnosis | Action |
|---|---------|-----------|--------|
| 36 | Low CPL + low CR2 | Cheap but unqualified leads | Optimize for quality, not volume |
| 37 | CR2 fluctuating but CPL stable | Sales team speed varying | Flag: optimizing for uncontrollable variable |
| 38 | Meta leads ≠ CRM leads | Attribution/tracking gap | Calculate and apply discrepancy ratio |
| 39 | 55+ lower CPA but lower CR3 | Front-end vs back-end trade-off | Calculate net value per lead by segment |
| 40 | Gross CPL good, net CPL bad | Lead quality issue | Check lead-to-qualified ratio |
