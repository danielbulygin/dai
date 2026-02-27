# Ada's Metric Reference

## Available Metrics by Level

### Account Level (get_client_performance)

Daily aggregate metrics for the entire ad account.

| Metric | Column | Type | Interpretation |
|--------|--------|------|----------------|
| Spend | spend | currency | Daily ad spend in account currency |
| Impressions | impressions | count | Total ad impressions across all campaigns |
| Reach | reach | count | Unique people reached |
| Frequency | frequency | ratio | impressions / reach — CHECK FIRST. >3.0 = warning, >3.5 = kill territory |
| Clicks | clicks | count | All clicks (includes likes, comments, shares) |
| Link Clicks | link_clicks | count | Clicks that go to the destination URL |
| Unique Link Clicks | unique_link_clicks | count | Deduplicated link clicks (one per person) |
| Content Views | content_views | count | Product/page view events (view_content) |
| Add to Carts | add_to_carts | count | Add-to-cart events |
| Checkouts Initiated | checkouts_initiated | count | Checkout-started events |
| Purchases | purchases | count | Completed purchase events |
| Purchase Value | purchase_value | currency | Total revenue attributed to ads |
| ROAS | roas | ratio | Return on ad spend (purchase_value / spend) |
| CPM | cpm | currency | Cost per 1,000 impressions |
| CTR (All) | ctr | percentage | All clicks / impressions |
| CTR (Link) | ctr_link | percentage | Link clicks / impressions |
| CPC | cpc | currency | Cost per click (all clicks) |
| Results | results | count | Primary conversion events (depends on campaign objective) |
| Cost per Result | cost_per_result | currency | Spend / results |
| Leads | leads | count | Lead form submissions |
| Complete Registrations | complete_registrations | count | Registration completion events |
| Actions | actions | JSON | Raw actions array — contains all event types and values |

### Campaign Level (get_campaign_performance)

Same metrics as account level, broken down by campaign. Adds:

| Metric | Column | Type | Interpretation |
|--------|--------|------|----------------|
| Campaign ID | campaign_id | string | Meta campaign identifier |
| Campaign Name | campaign_name | string | Human-readable campaign name |
| Status | status | string | ACTIVE, PAUSED, etc. |
| Objective | objective | string | Campaign objective (CONVERSIONS, TRAFFIC, etc.) |
| *(plus all account-level metrics)* | | | |

### Ad Set Level (get_adset_performance)

Campaign metrics broken down by ad set. Adds:

| Metric | Column | Type | Interpretation |
|--------|--------|------|----------------|
| Campaign ID | campaign_id | string | Parent campaign identifier |
| Ad Set ID | adset_id | string | Meta ad set identifier |
| Ad Set Name | adset_name | string | Human-readable ad set name |
| Status | status | string | ACTIVE, PAUSED, etc. |
| Targeting Audience Type | targeting_audience_type | string | Broad, lookalike, custom, etc. |
| *(plus all account-level metrics except leads, complete_registrations)* | | | |

### Ad Level (get_ad_performance)

Most granular — individual ad performance. Full creative metrics available here only.

| Metric | Column | Type | Interpretation |
|--------|--------|------|----------------|
| Campaign ID | campaign_id | string | Parent campaign |
| Ad Set ID | adset_id | string | Parent ad set |
| Ad ID | ad_id | string | Meta ad identifier |
| Ad Name | ad_name | string | Human-readable ad name |
| Status | status | string | ACTIVE, PAUSED, etc. |
| Creative ID | creative_id | string | Links to creatives table |
| **Video Metrics** | | | |
| Video Plays | video_plays | count | Total video play starts |
| Video 25% | video_p25 | count | Views reaching 25% of video |
| Video 50% | video_p50 | count | Views reaching 50% of video |
| Video 75% | video_p75 | count | Views reaching 75% of video |
| Video 100% | video_p100 | count | Views reaching 100% of video |
| ThruPlays | thruplays | count | Views of 15s or full video (whichever shorter) |
| Avg Watch Time | video_avg_time | seconds | Average time spent watching |
| Hook Rate | hook_rate | percentage | Pre-calculated: video_p25 / impressions |
| Hold Rate | hold_rate | percentage | Pre-calculated: video_avg_time / video_duration |
| **Funnel Metrics** | | | |
| Landing Page Views | landing_page_views | count | Confirmed page loads (not just clicks) |
| Content Views | content_views | count | Product/page view events |
| Add to Carts | add_to_carts | count | ATC events |
| Checkouts Initiated | checkouts_initiated | count | IC events |
| **Pre-calculated Rates** | | | |
| PDP View Rate | pdp_view_rate | percentage | content_views / link_clicks |
| ATC on PDP Rate | atc_on_pdp_rate | percentage | add_to_carts / content_views |
| Checkout Abandonment | checkout_abandonment_rate | percentage | 1 - (purchases / checkouts_initiated) |
| Conversion Rate | conversion_rate | percentage | purchases / link_clicks |
| Revenue per Click | revenue_per_click | currency | purchase_value / link_clicks |
| *(plus standard: spend, impressions, reach, frequency, clicks, link_clicks, unique_link_clicks, ctr, ctr_link, unique_ctr_link, cpm, cpc, purchases, purchase_value, roas, results, cost_per_result, actions)* | | | |

### Breakdowns (get_breakdowns)

Cross-dimensional slicing of metrics. Available breakdown types: `age`, `gender`, `country`, `region`, `placement`, `device_platform`, `platform_position`, `impression_device`.

| Metric | Column | Type | Interpretation |
|--------|--------|------|----------------|
| Date | date | date | Day of data |
| Breakdown Type | breakdown_type | string | Which dimension (age, gender, country, etc.) |
| Breakdown Value | breakdown_value | string | The segment value (e.g., "25-34", "US", "ios") |
| Spend | spend | currency | Spend for this segment |
| Impressions | impressions | count | Impressions for this segment |
| Clicks | clicks | count | All clicks |
| Link Clicks | link_clicks | count | Destination clicks |
| Results | results | count | Primary conversions |
| Cost per Result | cost_per_result | currency | Spend / results |
| Purchases | purchases | count | Purchase events |
| Purchase Value | purchase_value | currency | Revenue |

### Account Changes (get_account_changes)

Audit trail of changes made to the ad account.

| Field | Column | Type | Interpretation |
|-------|--------|------|----------------|
| Event Time | event_time | timestamp | When the change happened |
| Event Type | event_type | string | CREATE, UPDATE, DELETE, etc. |
| Object Type | object_type | string | campaign, adset, ad, etc. |
| Object ID | object_id | string | Meta ID of changed object |
| Object Name | object_name | string | Human-readable name |
| Actor | actor_name | string | Who made the change |
| Extra Data | extra_data | JSON | Old/new values, specific fields changed |

### Creative Details (get_creative_details)

Rich creative metadata with scoring and fatigue detection.

| Field | Column | Type | Interpretation |
|-------|--------|------|----------------|
| Creative ID | creative_id | string | Meta creative identifier |
| Ad ID | ad_id | string | Associated ad |
| Ad Name | ad_name | string | Human-readable name |
| Ad Type | ad_type | string | video, image, carousel, etc. |
| Status | status | string | ACTIVE, PAUSED, etc. |
| Format | format | string | Creative format details |
| Primary Text | primary_text | string | Ad copy body |
| Headline | headline | string | Ad headline |
| Description | description | string | Ad description/link description |
| Call to Action | call_to_action | string | CTA button text |
| Link URL | link_url | string | Destination URL |
| Video Duration | video_duration_seconds | number | Video length in seconds |
| Transcript | transcript | string | Video transcript (if available) |
| **Scoring** | | | |
| Hook Score | hook_score | 0-100 | Scroll-stopping power rating |
| Watch Score | watch_score | 0-100 | Content engagement rating |
| Click Score | click_score | 0-100 | Click-through effectiveness rating |
| Convert Score | convert_score | 0-100 | Conversion effectiveness rating |
| **Fatigue** | | | |
| Is Fatigued | is_fatigued | boolean | Whether creative shows fatigue signals |
| Fatigue Detected | fatigue_detected_at | timestamp | When fatigue was first detected |
| **Tagging** | | | |
| AI Tags | ai_tags | JSON | Auto-generated creative tags |
| Custom Tags | custom_tags | JSON | Manual tags |
| Campaign Name | campaign_name | string | Parent campaign |
| Ad Set Name | adset_name | string | Parent ad set |
| Last Active | last_active_at | timestamp | When creative last had spend |

---

## Custom / Calculated Metrics

These are NOT stored in the database — compute them from raw columns.

| Metric | Formula | When to Use | Benchmark |
|--------|---------|-------------|-----------|
| Hook Rate | video_p25 / impressions | Scroll-stopping power (use pre-calc column at ad level) | 25-30%+ good, 30%+ excellent |
| Hold Rate | video_avg_time / video_duration | Content engagement depth (use pre-calc column at ad level) | 20-40% typical |
| Thruplay Rate | thruplays / impressions | 15s+ engagement rate | 10-20% typical |
| PDP View Rate | content_views / link_clicks | Landing page effectiveness — are clicks reaching product pages? | 60-80% typical |
| ATC Rate | add_to_carts / content_views | E-commerce funnel: product page → cart | 5-15% typical |
| Checkout Rate | checkouts_initiated / add_to_carts | Cart abandonment signal | 40-70% typical |
| Conversion Rate | purchases / link_clicks | Full-funnel efficiency from click to purchase | 1-5% typical |
| Revenue per Click | purchase_value / link_clicks | Attribution-independent efficiency metric — Daniel's preferred KPI | Account-specific |
| Cost per Click (Link) | spend / link_clicks | Traffic efficiency | Varies by vertical |
| CPA | spend / purchases | Cost per acquisition | Account-specific target |
| AOV | purchase_value / purchases | Average order value — needed to contextualize CPA | Account-specific |
| ROAS | purchase_value / spend | Return on ad spend (also available pre-calculated) | Account-specific target |
| Cost per ATC | spend / add_to_carts | Upper-funnel cost efficiency | $5-15 typical e-com |
| Cost per Lead | spend / leads | Lead-gen primary metric | Account-specific target |
| Landing Page View Rate | landing_page_views / link_clicks | Page load success rate | 70-90% typical |
| Video Drop-off | 1 - (video_p100 / video_p25) | Content retention loss | 60-80% drop is normal |

---

## Anomaly Signals (Compound Patterns)

These are multi-metric patterns that indicate specific problems. Never diagnose from a single metric.

### Out of Stock Signal
- **Pattern:** ATC rate drops >40% vs 7-day avg AND CTR stable AND traffic stable
- **Confidence:** High if affects specific products, not whole account
- **Action:** Alert P0, check product availability
- **Verify:** Compare ATC rate across campaigns — if only some drop, it's product-specific

### Creative Fatigue Signal
- **Pattern:** Frequency >3.0 AND CTR declining AND CPM stable AND hook_rate declining
- **Confidence:** High if same creatives running >14 days
- **Action:** Alert P1, need new creative
- **Verify:** Check `is_fatigued` flag on creatives, confirm frequency trend over 7+ days

### Landing Page Issue Signal
- **Pattern:** CTR stable or improving AND PDP view rate drops >30% AND landing_page_view_rate drops
- **Confidence:** Medium-high, confirm with website check
- **Action:** Alert P1, check landing page speed/availability
- **Verify:** Check if issue is device-specific (use device breakdown)

### Platform-Wide Issue Signal
- **Pattern:** 3+ accounts show same metric dip on same day AND no account-specific changes
- **Confidence:** High
- **Action:** Alert P2, wait 24-48h before making changes
- **Verify:** Use `get_account_changes` to confirm no manual changes were made

### Budget Pacing Issue Signal
- **Pattern:** Daily spend <70% or >130% of daily budget target
- **Confidence:** High
- **Action:** Alert P1 if underspend (missed opportunity), P0 if overspend >150%
- **Verify:** Check account changes for recent budget edits

### Honeymoon Phase Warning
- **Pattern:** New campaign <14 days old AND CPA significantly below target
- **Confidence:** Medium — performance may normalize as learning phase ends
- **Action:** Alert P3 (FYI), don't scale yet, let it cook
- **Verify:** Check if campaign has exited learning phase (>50 conversions/week)

### Audience Saturation Signal
- **Pattern:** Frequency rising AND CPA rising AND reach declining over 7+ days
- **Confidence:** High
- **Action:** Alert P1, need audience expansion or new TOF campaign
- **Verify:** Check reach trend and compare audience overlap between ad sets

### Attribution Window Shift
- **Pattern:** ROAS drops but revenue per click stable
- **Confidence:** Medium — could be attribution model change or iOS signal loss
- **Action:** Cross-reference with Shopify/GA data, check revenue per click trend
- **Verify:** Compare 1-day vs 7-day attribution windows if available

### Audience Network Leakage
- **Pattern:** High CTR (>5%) AND low conversion rate AND placement breakdown shows Audience Network >20% of spend
- **Confidence:** High
- **Action:** Alert P1, exclude Audience Network or add placement targeting
- **Verify:** Check placement breakdown via `get_breakdowns({ breakdownType: 'placement' })`

### Checkout Friction Signal
- **Pattern:** ATC rate stable AND checkout rate drops >30% AND checkout_abandonment_rate rising
- **Confidence:** High — issue is between cart and purchase
- **Action:** Alert P1, check checkout flow (shipping costs, payment options, promo codes)
- **Verify:** Check if issue is device-specific or country-specific via breakdowns

### Scaling Degradation Signal
- **Pattern:** Budget increased >30% in last 3 days (check account_changes) AND CPA rising >20% AND frequency rising
- **Confidence:** High — algorithm pushed into less efficient audience segments
- **Action:** Alert P1, revert budget or slow scaling pace
- **Verify:** Cross-reference `get_account_changes` timestamps with CPA trend

---

## Statistical Significance

### Minimum Sample Sizes Before Flagging Anomalies

Do not flag anomalies unless these thresholds are met:

| Metric Type | Minimum Threshold | Rationale |
|-------------|-------------------|-----------|
| Spend-based | >$50/day for the account | Below this, variance is noise |
| Click-based | >100 clicks in the period | Insufficient for rate-based metrics |
| Conversion-based | >10 conversions in the period | CPA/ROAS need this for any signal |
| Creative metrics | >1,000 impressions per ad | Hook/hold rates unstable below this |
| Funnel rates (ATC, IC) | >50 events in the period | Rate changes unreliable with small counts |
| Breakdown segments | >$20 spend per segment | Don't compare segments with trivial spend |

### Anomaly Detection Thresholds (vs 7-day rolling average)

| Severity | Statistical Signal | Duration | Priority |
|----------|-------------------|----------|----------|
| **Watch** | >1.5 standard deviations | 1 day | P2 |
| **Alert** | >2 standard deviations, 1 day OR >1.5 std dev for 2+ consecutive days | 1-2 days | P1 |
| **Critical** | >3 standard deviations OR 0 conversions with >$100 spend | 1 day | P0 |
| **FYI** | Notable pattern that doesn't meet alert threshold | N/A | P3 |

### Rate-of-Change Thresholds

When comparing day-over-day or week-over-week:

| Change | Assessment | Action |
|--------|-----------|--------|
| <10% | Normal variance | No action |
| 10-20% | Worth noting | Monitor next day |
| 20-40% | Significant | Investigate root cause |
| >40% | Critical | Immediate investigation |
| >60% | Likely data issue or major event | Verify data quality first |

### Comparison Periods

- **Short-term trend:** Compare today vs yesterday, today vs 7-day avg
- **Medium-term trend:** Compare last 7 days vs prior 7 days
- **Long-term baseline:** Compare last 30 days vs prior 30 days
- **Seasonality check:** Compare vs same period last year (if data available)
- **Always prefer 7-day rolling averages** over single-day comparisons to reduce noise
