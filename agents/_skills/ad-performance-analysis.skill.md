---
name: ad-performance-analysis
description: "Analyze Facebook/Meta ad performance and provide optimization recommendations"
tags: [advertising, analytics, meta, facebook, performance]
---

# Ad Performance Analysis Skill

Comprehensive knowledge for analyzing Meta/Facebook ad account performance, diagnosing issues, and providing data-driven optimization recommendations.

## Analysis Sequence (Always Follow This Order)

### Step 1: Tracking Validation (Events Manager)

Before looking at any performance data, validate that tracking is working correctly.

| Check | What to Look For | Red Flags |
|-------|------------------|-----------|
| Pixel Status | Is it firing? Any duplicates? | "No activity" on pixel |
| CAPI Coverage | Conversion API sending events? | Only browser events, no server events |
| Match Quality Score | Should be >8.0 | Missing FBC, missing external_id |
| Advanced Matching | Should be enabled | All toggles disabled |
| Optimization Target | What event are ads optimizing for? | Optimizing for ATC or IC instead of Purchase |
| Deduplication | Events not double-counting? | Same event firing multiple times |

### Step 2: Top-Level Spend Overview

Quick context gathering:
- How much spent in last 30 days?
- Across how many campaigns?
- What is the account structure? (CBOs vs ABOs, by country, by funnel stage)
- What currency is the account in?
- What timezone?

### Step 3: Account Structure Analysis

- Campaign strategy: CBOs vs ABOs? Cost caps? Bid caps?
- Geographic split: By country? By region? All in one?
- Funnel split: TOF/MOF/BOF? Or all in one?
- Naming conventions: Consistent? Can you identify what each thing is?
- Audience definitions: Are engaged/existing audiences properly defined?

**Red flags:**
- Campaigns with inconsistent strategies
- Names that do not match settings (e.g., "Target CPL $54" but actual setting says $79)
- Mixed locations/bidding across campaigns making analysis impossible

### Step 4: Top Spending Creatives

Sort ads by spend and analyze:
1. What format? (Video, static, carousel, UGC, DPA)
2. What is the hook/first impression?
3. Is it pre-qualifying the right audience?
4. What landing page does it go to?

### Step 5: Metric Deep Dive

Analyze metrics at each level of the funnel.

### Step 6: Breakdowns (When Numbers Look Off)

Trigger breakdown analysis when numbers do not make sense, when investigating winners/losers, or when anomalies are detected.

### Step 7: Historical Context

When performance changes, investigate what changed and when.

## Key Metrics Reference

### Basic Metrics (Direct from API)

| Metric | Description | Type |
|--------|-------------|------|
| spend | Amount spent | Currency |
| impressions | Number of times ad was shown | Integer |
| reach | Unique accounts that saw the ad | Integer |
| frequency | Average times each account saw the ad | Decimal |
| clicks | All clicks (including likes, comments) | Integer |
| link_clicks | Clicks on links in the ad | Integer |
| cpm | Cost per 1,000 impressions | Currency |
| cpc | Cost per click (all) | Currency |

### Video Metrics

| Metric | Description |
|--------|-------------|
| video_p25 | Views at 25% of video |
| video_p50 | Views at 50% of video |
| video_p75 | Views at 75% of video |
| video_p100 | Views at 100% of video |
| thruplays | Views of 15s or complete video (whichever comes first) |
| video_avg_time | Average video watch time (seconds) |

### Conversion Metrics (from actions array)

| Metric | Action Type | Description |
|--------|-------------|-------------|
| content_views | view_content | Product page views |
| add_to_carts | add_to_cart | Add to cart events |
| checkouts_initiated | initiate_checkout | Checkout started |
| purchases | purchase | Completed purchases |
| purchase_value | purchase (from action_values) | Total revenue |
| leads | lead | Lead form submissions |

### Calculated Metrics

| Metric | Formula | Description |
|--------|---------|-------------|
| CTR (all) | clicks / impressions | Click-through rate (all clicks) |
| CTR (link) | link_clicks / impressions | Link click-through rate |
| Hook Rate | video_p25 / impressions | First ~3 seconds retention |
| Hold Rate | video_avg_time / video_duration | Average % of video watched |
| Thruplay Rate | thruplays / impressions | Rate of 15s+ views |
| PDP View Rate | content_views / link_clicks | % of clicks reaching product page |
| ATC Rate | add_to_carts / content_views | % of page views that add to cart |
| Checkout Rate | checkouts_initiated / add_to_carts | % of ATC that start checkout |
| Conversion Rate | purchases / link_clicks | % of clicks resulting in purchase |
| ROAS | purchase_value / spend | Return on ad spend |
| CPA | spend / purchases | Cost per acquisition |
| AOV | purchase_value / purchases | Average order value |
| Revenue per Click | purchase_value / link_clicks | Revenue per link click |

### Metric Categories for Reporting

**Engagement and Creative:** impressions, frequency, hook_rate, hold_rate, video_avg_time, thruplay_rate

**Click-Through and Traffic:** ctr_all, ctr_link, ctr_outbound, pdp_view_rate

**Conversion and Sales:** atc_rate, checkout_rate, conversion_rate, aov, revenue_per_click

**Cost and Efficiency:** cpm, cpc, cpa, cost_per_atc, roas

## Hook Rate Benchmarks

| Rate | Assessment | Action |
|------|------------|--------|
| 30%+ | Excellent | Scale, celebrate, analyze why it works |
| 25-30% | Solid | Can test, may iterate |
| 20-25% | Below average | Needs iteration on opening |
| Below 20% | Weak | Kill or major rework |

Target: 30%+ for TOF broad targeting.

## E-Commerce Funnel Diagnosis

| Stage | Metric | Low Value Means |
|-------|--------|-----------------|
| Click to LPV | Landing Page View Rate | Page load issues, redirects |
| LPV to VC | View Content Rate | People not finding products |
| VC to ATC | Add to Cart Rate | Product/price issues, wrong audience, out of stock |
| ATC to IC | Checkout Rate | Friction in checkout |
| IC to Purchase | Purchase Rate | Shipping costs, payment issues |

## Anomaly Pattern Recognition

| Anomaly | What It Usually Means | Investigation Path |
|---------|----------------------|-------------------|
| High CTR + Low CVR | Wrong audience clicking - pre-qualification issue | Check creative messaging, first 3 seconds |
| Good hook rate + bad results | Content after hook is not engaging | Check hold rate, watch time |
| Social profile CTR spike | Creative driving people to IG instead of website | Review video content, check what is different |
| CPL/CPA differences by region | Some markets convert better | Check CPM differences, audience size |
| Frequency spike + ROAS drop | Audience saturation | Check reach trends, consider audience expansion |
| iOS ROAS > Android ROAS | Premium audience correlation | Consider if product is premium-positioned |
| PDP view rate tracks ROAS | Traffic quality indicator | Focus on improving traffic quality |

## Root Cause Investigation Tree

When performance drops, follow this diagnostic tree:

```
Performance Drop
|
+-- Check Funnel First
|   +-- ATC drop? -> Check landing page (out of stock? price change?)
|   +-- CVR drop? -> Check checkout flow (shipping? payment?)
|   +-- LPV drop? -> Check page speed, redirects
|
+-- Check Audience Next
|   +-- Frequency high? -> Audience saturation
|   +-- Reach dropping? -> Budget or audience exhaustion
|   +-- CPM spike? -> Competition or seasonality
|
+-- Check Placements
|   +-- Audience Network spend? -> Placement leakage (wasted budget)
|   +-- Social profile CTR up? -> Traffic going to IG not website
|   +-- New placements appearing? -> Auto-placement issues
|
+-- Check Creatives
|   +-- CTR dropping? -> Creative fatigue
|   +-- Hook rate down? -> Opening not working
|   +-- Same ads for months? -> Need fresh creative
|
+-- Check External
    +-- Seasonality? -> Google Trends
    +-- Account changes? -> Edit history
    +-- Website changes? -> Check landing pages
```

## Breakdown Analysis

Use breakdowns when numbers look strange or to understand what is driving performance.

| Breakdown | When to Use | What to Look For |
|-----------|-------------|------------------|
| Country | Multi-geo campaigns | CPM differences (US often 5-6x Europe), CVR by market |
| Placement | CTR anomalies, CPA spikes | Audience Network waste, rewarded video |
| Age/Gender | CVR differences | Wrong demo getting spend |
| Device | CVR differences | iOS often higher ROAS than Android |
| Platform | Instagram vs Facebook | Where performance is coming from |

## Meta Ads API Quick Reference

### Common API Field Sets

**Performance Audit:**
`spend,impressions,clicks,cpc,cpm,ctr,reach,frequency,actions,cost_per_action_type`

**Campaign Level:**
`campaign_name,spend,impressions,clicks,cpc,cpm,ctr,reach,frequency,actions,cost_per_action_type`

**Ad Level:**
`ad_name,adset_name,campaign_name,spend,impressions,clicks,cpc,cpm,ctr,actions,cost_per_action_type`

**Creative Analysis (with video metrics):**
`ad_name,spend,impressions,actions,cost_per_action_type,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions,video_avg_time_watched_actions`

**For ROAS calculation:**
`spend,impressions,clicks,actions,action_values,cost_per_action_type`

### Date Presets

| Preset | Description |
|--------|-------------|
| today | Today only |
| yesterday | Yesterday only |
| last_7d | Last 7 days |
| last_14d | Last 14 days |
| last_30d | Last 30 days |
| last_90d | Last 90 days |
| this_month | Current month |
| last_month | Previous month |

### Common API Gotchas
1. Currency is in account's default currency - always check first
2. Actions array can be empty - use fallback values
3. Large accounts need pagination - add limit=500 for ad-level queries
4. Date ranges are inclusive - "last_7d" includes today
5. Rate limits apply - batch requests where possible

## Optimization Recommendations Framework

### Scaling Criteria
- ROAS above target for at least 3-5 days consistently
- Sufficient conversion volume (exit learning phase)
- Frequency below saturation threshold
- Scale budget by 20-30% increments, not dramatic jumps

### Budget Rules
- Do not double budgets overnight (causes re-learning)
- Increase by 20-30% every 2-3 days when scaling
- If performance drops after scaling, revert to previous budget and wait
- For CBOs: let the algorithm distribute across ad sets
- For ABOs: manage budgets at ad set level manually

### When to Kill an Ad
- Below benchmark CPA for 3+ days with sufficient spend
- Hook rate consistently below 20%
- Frequency above 3-4 in prospecting campaigns
- CTR declining week over week with no improvement

### When to Iterate
- Hook rate below 25% but concept is strong: test new hooks
- Good hook rate but low conversion: rework body/CTA
- Good metrics but high CPA: check landing page or targeting
- Strong creative fatiguing: create variations with same concept, different hooks

## Output Format for Analysis

When presenting analysis results, structure the output as:

1. **Issue** - What the specific metric/value is
2. **Investigation** - What breakdown data revealed
3. **Root Cause Hypothesis** - What is likely causing the issue
4. **Recommended Action** - Specific, actionable next step

Example: "US CPA is $91 vs $43 in Ontario. Investigation: US CPM is 2x higher, trial CVR is 35% lower. Root cause: Market economics + audience fit. Recommendation: Reduce US budget, test Canadian expansion, use Google Trends to find high-interest markets."
