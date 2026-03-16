# Audibene — Comprehensive Tracking, KPIs & Performance Briefing

> **Purpose**: Reference document for AI agents performing performance analysis and creative strategy for the Audibene account. Synthesized from 16 internal and client call transcripts (Jan–Mar 2026).
>
> **Intended audience**: Ada (media buying AI), Maya (creative strategy AI), or any agent analyzing Audibene performance.

---

## 1. Company Overview

- **Business**: Hearing aids manufacturer & direct-to-consumer retailer
- **Brands**: Audibene (main commercial brand) + Hören Heute (comparison portal / secondary brand)
- **Revenue**: ~€200M/year total, ~€80M in Germany
- **Market**: DACH region — Germany (primary, Ads on Tap scope), Austria, Switzerland
- **Products**: Fully in-ear (invisible) and behind-the-ear (stronger processing, noise cancellation/voice isolation)
- **Target audience**: First-time hearing aid buyers, aspirational 50–65+ year-olds (not 80+)
- **Insurance**: German Krankenkasse subsidizes up to €1,500 every 5 years for hearing aids
- **Sales cycle**: 3–6 months from initial lead to closed sale — weekly ad performance and downstream revenue are completely decoupled

---

## 2. The Full Funnel

```
Ad Impression → Click → Landing Page View → Quiz/Questionnaire Start
  → Quiz Completion (Lead) → Net Lead (post auto-close filter)
    → Sales Rep Contact → First Care Appointment → Prescription → Purchase/Sale (Revenue)
```

### Funnel Stage Definitions

| Stage | Description | Key Event |
|-------|-------------|-----------|
| **Link Click** | User clicks the ad (Meta or Google) | Standard click event |
| **Landing Page View (LPV)** | User reaches the landing page; LPV share is a tracked metric | Meta pixel LPV event |
| **Quiz/Questionnaire Start** | User begins the hearing questionnaire | "First question answered" / "Questionnaire started" event |
| **Quiz Completion / Lead** | User completes questionnaire and provides personal info (phone, email) | Lead event fires at phone number step |
| **Net Lead** | Lead that passes auto-close filters — **the primary Meta optimization event** | Custom `NetLead` event |
| **Opportunity** | Sales consultant creates a record in Salesforce after calling the lead | Salesforce event |
| **First Care Appointment** | In-person consultation at an Akustiker (hearing specialist) | Tracked in Domo/Salesforce |
| **Prescription** | Lead receives or already has a hearing aid prescription | Tracked in Domo/Salesforce |
| **Purchase/Sale** | Final hearing aid purchase — the ultimate business outcome | Tracked in Salesforce, fed back via CAPI |

### Two Funnel Paths (Meta)

| Path | Flow | Characteristics |
|------|------|----------------|
| **A — Landing Page First** (default) | Ad → Landing Page → CTA ("Check availability") → Quiz → Lead | Higher volume, lower lead quality, higher CPA. Only ~20% of LP visitors click through to quiz. |
| **B — Direct to Quiz** | Ad → Quiz directly → Lead | Better lead quality, lower CPA, higher cost per net lead. Only a few legacy Audibene ads use this. |

Daniel's insight: "If only 20% of landing page visitors click through to the quiz, and quiz completion rates are similar in both paths, then the landing page is just losing 80% of traffic for no gain."

---

## 3. Conversion Rate Stages (CR1, CR2, CR3)

These are the three critical conversion rates that define the post-lead funnel:

| Rate | Transition | What It Measures | Benchmarks |
|------|-----------|------------------|------------|
| **CR1** | Click/Traffic → Net Lead | Top-of-funnel; form/quiz completion rate. Affected by LP quality, quiz design, targeting. | ~2.5% net lead CVR (varies by day/LP) |
| **CR2** | Net Lead → First Care Appointment | Whether a lead is contacted by sales and books an appointment. Depends on lead reachability (mobile vs. landline), sales team capacity, and lead quality. | **Target: 20–25%**, Actual avg: ~15.7% (Mar '26), AOT CBO achieves 26% |
| **CR3** | First Care → Purchase/Sale | Whether the appointment converts to a hearing aid purchase. **The single most important metric** — determines whether a channel gets more or less spend, regardless of CPA. | **Average: ~25%**, 55–64 cohort: ~20% |

### The CR2/CR3 Inverse Correlation (Critical)

This is the most important analytical insight for this account:

- Leads with high **first care share** tend to have good CR2 but **lower CR3**
- Leads with high **prescription share** tend to have lower CR2 but the **best CR3** (most likely to buy)
- **Optimizing for CR2 alone can hurt CR3 and overall revenue**
- The ideal optimization metric is **CPA adjusted by predicted CR3** — i.e., CR2 × CR3 composite
- Manuel's rule: "If we see the CR3 is less good independent of the CPA than other channels, we would steer that channel down."

### CR2 Data Completeness Rules

- CR2 depends on leads being **contacted/reached by sales** — sales doesn't work weekends
- If there are **zero open leads** for a given day in Domo → that day's data is complete
- Weekend leads processed Monday/Tuesday → full picture available by **Tuesday morning**
- Monday-to-Friday windows are the reliable baseline for analysis
- Data attributed to **lead creation date**, not opportunity creation date

---

## 4. Lead Quality Attributes & Scoring

### Lead Quality Buckets (Best to Worst)

1. **Follow-up care** (repeat customer, has previous hearing aids) — Second best overall
2. **First care + has prescription** — Best bucket for new customers
3. **First care + no prescription** — Worst bucket; CR3 is particularly low

### Key Lead Attributes

| Attribute | Impact on Performance | Notes |
|-----------|----------------------|-------|
| **Degree of Suffering** | Higher suffering = higher CR2 + CR3 = more likely to buy | Self-reported in quiz. Options: "not at all," "barely," "severe." "Not at all" is the biggest negative differentiator — mostly auto-closed. |
| **First Care Share** | Strongest positive signal for CR2 | But may inversely correlate with CR3 — use with caution |
| **Prescription Share** | Lower CR2 but best indicator of actual purchase (CR3) | "Even if their CR2 is lower, we need to be cautious that we're not avoiding them" — Steven |
| **Age** | 55–64: higher initial CVR but lower CR3 (~20% vs 25%) | Requires CPA target adjustment (€100 vs €139 for 65+) |
| **Mobile vs. Landline** | Mobile = more reachable = better CR2 | No form distinction at submission; determined post-hoc. ~70–80% fewer "lead with mobile" events than net leads. |
| **Age of Current Hearing Aids** | >5–6 years = qualifies for Krankenkasse subsidy | Critical for follow-up care leads |
| **Insurance Availability** | Affects ability/motivation to purchase | Factor in lead scoring |
| **Geographic/Zip Code** | Some zip codes auto-closed (partner coverage gaps) | |

### Auto-Close Rules (Pre-CR2 Filtering)

Leads can complete the questionnaire but be auto-closed before a sales rep ever contacts them:

- First care + no prescription → auto-close
- "Not at all" degree of suffering → auto-close
- Certain age groups → auto-close
- Excluded zip codes (partner coverage gaps) → auto-close
- Certain traffic sources → auto-close

**Impact**: Auto-closed leads affect Net Lead count and can skew CR2 data. The auto-close filter sits between Lead and Net Lead in the funnel.

### Lead Scoring Initiative (Highest Strategic Priority)

- **Current state**: Rule-based negative scoring only (auto-close bad leads)
- **Target state**: Monetary lead scoring — assign a € value per lead based on ~5 characteristics in a weighted matrix
- **Builder**: Giancarlo (Audibene data analyst)
- **Why it matters**: "This will change everything about the way we work. This will change how the algorithm thinks of your account." — Daniel
- **Enables**: ROAS-based bidding on Google ("the Holy Grail"), value-based optimization on Meta
- **Key insight**: "Every single parameter that we're sending has some sort of monetary value" — but the weighting is the missing piece
- **Risk**: Overfitting — needs backtesting against historical revenue per lead data

---

## 5. KPI Targets & Benchmarks

| Metric | Target / Benchmark | Notes |
|--------|-------------------|-------|
| **CPA — Cost per Appointment (65+)** | **€139** | Primary contractual target for Meta |
| **CPA — Cost per Appointment (55–64)** | **~€100** | Adjusted down ~25% to compensate for lower CR3 |
| **CR2** | **20–25%** | 22% = conservative realistic; 26% = AOT CBO level ("things get fun") |
| **CR3** | **~25%** avg | ~20% for 55–64 cohort |
| **CPL (Net Lead)** | Secondary | "We don't really care about CPL. We care about the appointment and the sale after that." |
| **Cost per Purchase** | The "most bottom of the bottom lines" | Takes ~6 months to fully attribute |
| **ROMI** | The ultimate steering metric | Return on Marketing Invest — what Manuel watches |
| **Daily Meta Budget** | **€2,200** (Mar target) | ±10–20% flexibility acceptable; 40–50% swings are not |
| **Google Monthly Spend** | **€30–40K** | Scalable to €45–60K+ with restructuring |
| **Frequency** | **1.0–1.05 daily avg** = healthy | Higher = audience saturation; creative refresh needed |
| **Low-quality tolerance** | **Max 10% of spend** | Steven: 10% cheap/low-quality is acceptable short-term |

### Creative Performance Metrics

| Metric | What It Measures | Audibene Caveat |
|--------|-----------------|-----------------|
| **Hook Rate** | First 3 seconds capture | Does NOT reliably predict Audibene's business KPIs |
| **Hold Rate** | Sustained viewing | Often does NOT correlate with CPA for Audibene |
| **Click Rate / CTR** | Click-through | Useful but insufficient alone |
| **Conversion Rate** | Downstream conversion | The only reliable creative metric for Audibene |

**Critical**: Steven explicitly stated: "When you're looking at iterating, you're looking at our KPIs mostly, because hold rate and things like that often for us don't correlate that well with our KPIs." Always evaluate creatives on CPA/downstream metrics, not engagement proxies.

---

## 6. Tracking & Measurement Architecture

### Data Pipeline

```
Meta/Google Ads → Landing Page → Quiz Form → Audibene Backend
  → Salesforce (CRM — source of truth for all lead data)
    → Snowflake (data warehouse — API access blocked)
      → Domo (BI/reporting — refreshes ~2x daily)
        ↩ Back to Meta via CAPI / Back to Google via Offline Imports
```

### Platforms & Tools

| Tool | Purpose | Access |
|------|---------|--------|
| **Meta Pixel** | Frontend event tracking; on ALL pages across ALL channels | Via Events Manager |
| **Conversions API (CAPI)** | Server-side event matching via Salesforce → Snowflake | Reliability issues (volatile event volume) |
| **Salesforce** | CRM — source of truth for all lead data and outcomes | Indirect (via Domo exports) |
| **Snowflake** | Data warehouse | **Access blocked** by Audibene tech team (Kirill) |
| **Domo** | Primary BI/reporting dashboard | Read access; custom export profiles being set up |
| **Optimizely** | A/B testing for landing pages; ties into Salesforce | Managed by Toby (Audibene) |
| **Google Ads Offline Imports** | Feeds Salesforce lead quality data back to Google | Set up by Aaron/Michelle |

### Meta Pixel Events

| Event | Description |
|-------|-------------|
| **event_1, event_2** | Legacy events (compliance-related naming for health category) |
| **event_3a, event_3b, event_3_saves** | Custom events — includes degree of suffering variants |
| **Questionnaire Started** | User begins quiz (also labeled "first question answered" — naming confusion exists) |
| **Net Lead** | Primary optimization event — completed, non-auto-closed lead |
| **Lead with Mobile Number** | Subset of leads with mobile phone; ~70–80% less volume than net leads |
| **Degree of Suffering** | NEW event/parameter being added — first lead quality signal to Meta |

**Two Pixels**: Audibene pixel (main) + Ads on Tap pixel (agency). New events must fire on **both**.

### Key Tracking Constraints

1. **Health & Wellness Classification (Meta)**: Audibene's URL classified under health/wellness → restricted from sending PII related to medical conditions → limits audience building (lookalikes, retargeting restricted). Broad targeting + pre-qualifying creatives is the workaround.

2. **Google Enhanced Conversions blocked**: Health category prevents feeding downstream lead quality back to Google — can only optimize at lead level. Degree of suffering event is the workaround proxy.

3. **48-hour data lag**: Lead quality data only available after sales team contacts leads. Weekend leads processed Monday/Tuesday. Similar to app marketing where conversion data arrives 96+ hours late.

4. **Attribution**: Data attributed to **lead creation date**, not opportunity creation date. A Saturday lead with a Monday opportunity attributes to Saturday.

5. **Last-click attribution across ALL channels**: No multi-touch attribution exists. Steven: "Every channel is last click. It's difficult to really do anything that is to generate demand without that particular thing looking worse than maybe it is." No cross-channel attribution monitoring.

6. **CAPI reliability issues**: Pixel event volume wildly volatile (22–300 events/day when should be thousands). The Salesforce → Snowflake → CAPI pipeline has inconsistent firing.

7. **iOS tracking disruption**: Jan 5 2026 Apple OTA update degraded LPV share for iOS users. Android-only ad sets created to isolate.

8. **No real-time funnel report**: No Domo report showing full funnel from ad click through appointment. Intermediate funnel steps currently missing from available datasets.

---

## 7. Positive Performance Contributors

### Strategic Levers

| Lever | Expected Impact | Status |
|-------|----------------|--------|
| **Degree of suffering optimization** | Major CR2 + CR3 improvement by targeting high-severity leads | Event deployed, being validated |
| **Value-based lead scoring** | Enables ROAS bidding ("the Holy Grail") | Giancarlo building; delayed 3–4 weeks |
| **New creatives at volume** | Creative breakthroughs can "halve the CPL" overnight | Target: 20/week |
| **Landing page A/B testing** | Small LP changes swing CPL dramatically | Optimizely now accessible |
| **Video Sales Letter (VSL)** | QVC-style video LP to better educate prospects pre-form | Planned |
| **Cost cap / bid cap campaigns** | Sit out bad auctions, discover ultra-cheap lead pockets | Active testing |
| **Direct-to-quiz funnel path** | Better CPA than LP-first path | Few ads use this; needs testing at scale |
| **Monday decision cadence** | Complete weekend data available for informed decisions | Operational |

### Creative Insights (What Works)

- Emotional/vanity-driven messaging outperforms product-focused
- Key angles: exclusivity, financial shock, scarcity, technical newness
- Reaction-style videos with a single lead actor (authentic, slow-paced, no music)
- Native-style simple ads (similar to organic content)
- "Pain"-themed creatives aligned with degree of suffering
- Multiple hook versions on top performers
- 50–60 seconds is the typical length needed for quality filtering
- Shorter ads (25s) with early CTA showing promise but need downstream quality monitoring

### Campaign Structure

- Low frequency (1.0–1.05 daily average) = healthy fresh audience capture
- AOT testing campaign CBO achieves 26% CR2 vs 16% main campaign average
- Android-only ad sets isolate from iOS tracking degradation

---

## 8. Negative Performance Contributors

### Structural Issues

| Issue | Impact | Mitigation |
|-------|--------|------------|
| **Meta optimizes for net leads, not appointments** | Fundamental disconnect between platform optimization and business KPI | Lead scoring will fix this; degree of suffering is interim proxy |
| **48-hour data lag** | Prevents proactive optimization; forces reactive Monday steering | Accept and plan around it |
| **Last-click attribution only** | Demand-gen activities (awareness, lo-fi UGC) look worse than they are | Steven warns he'll ask to stop underperforming demand-gen even if it generates cross-channel demand |
| **Health category pixel restrictions** | Limits audience building, retargeting, Enhanced Conversions | Broad targeting + pre-qualifying creatives |
| **CR2/CR3 inverse correlation** | Optimizing appointments can hurt purchase rate | Composite CR2×CR3 metric needed |
| **Meta's lower CR3 vs other channels** | "Broader concern with Meta in general" — Steven | Monitor closely; channel allocation at stake |
| **Two Google accounts with overlapping keywords** | Circumventing Systems risk (Google policy) | Account separation/consolidation needed |

### Performance Risks

| Risk | Signal | Action |
|------|--------|--------|
| **55–64 age targeting** | CR3 ~20% vs 25% for 65+ | Adjust CPA target to ~€100 |
| **Audience saturation** | Frequency rising above 1.05 | Creative refresh, test 63+ to "shock the algorithm" |
| **Click-baity ads** | Good CPL but terrible CPA | Evaluate on CPA, not CPL — "tricking people in" |
| **Creative fatigue** | Performance walls before going vertical | Series of educated guesses; keep testing at volume |
| **CAPI inconsistency** | Volatile event counts | Work with Dmytro to stabilize |
| **Auto-close rule changes** | Shifts what counts as Net Lead | Re-baseline metrics after rule changes |

---

## 9. Google Ads Specifics

| Metric | Current State | Target |
|--------|--------------|--------|
| **Brand CPC** | ~€1.80 | €0.15–0.50 (manual CPC) |
| **Quality Score (Brand)** | 7–8/10 | 9–10/10 |
| **Quality Score (Generic)** | 7–9/10 | Maintain/improve |
| **Quality Score (Local/Akustiker)** | 2–4/10 | 7+/10 |
| **Impression Share Lost** | Up to 80% in some campaigns | Reduce via granular structure |
| **Monthly Spend** | ~€30–40K | €45–60K+ (50% increase achievable) |
| **Ad Groups per Campaign** | ~1 (single broad keyword) | 20–40+ per campaign |

**Key constraints**: No offline conversion import for purchases (health category blocks Enhanced Conversions). Can only optimize at lead level. Degree of suffering event can be ported as Custom Event.

**Two-brand structure**: Audibene (main commercial) + Hören Heute (originally for double-bidding / SERP presence, becoming objective comparison portal). Currently running in two separate accounts with overlapping keywords — policy risk.

---

## 10. Analysis Framework

### Daniel's Drill-Down Methodology

1. **Identify which metric dropped** (CPL, CR2, CPA, CR3, etc.)
2. **Drill down**: Campaign level → Ad set level → Ad level
3. **Identify the specific ad/ad set** causing the drop
4. **Investigate root cause** (audience, creative, bid strategy, tracking issue)
5. **Take action** based on root cause (not just observation)

"Our goal is to get the underlying reason" — never just report that a metric changed.

### Key Analytical Principles

- **CPM increases alone are NOT diagnostic** — good weeks have occurred with higher CPMs
- **A 7% CR2 is bad enough to kill a campaign immediately**
- **If CR1 is slightly lower but CR2 compensates, that's acceptable** (testing campaign pattern)
- **Weekend data is unreliable** — use Monday-to-Friday windows
- **Creative engagement metrics (hook rate, hold rate) often do NOT correlate with Audibene's business KPIs** — always evaluate on CPA/downstream
- **Quick CPA calculation**: Total Spend ÷ Opportunities (e.g., €8,905 / 27 ops = ~€330 CPA)
- **Net Lead CVR and net lead volume correlate strongly** — higher CVR = more leads, not just better quality
- **Cross-validate**: When performance looks anomalous, verify Meta numbers against Domo/CRM before acting

### Forecasting Caveat

Daniel is explicit that "forecasts rarely correlate with actual performance" and limited data points make predictions unreliable. Focus on directional trends and actionable levers, not point predictions.

---

## 11. Key People & Roles

### Audibene Team

| Person | Role | Relevance |
|--------|------|-----------|
| **Steven Roberts** | Channel Manager, Paid Social | Main point of contact; data/performance discussions, CR2/CR3 targets |
| **Manuel Stegmann** | Head of Growth | Strategic decisions, budget allocation, ROMI, channel mix |
| **Tobias/Toby** | Head of Growth Tech | Optimizely, landing page infrastructure, Dmytro's manager |
| **Giancarlo** | Data Analyst | Lead scoring algorithm, auto-close rules, CR analysis, Domo |
| **Dmytro/Dimitro** | Developer/MarTech | Pixel implementation, CAPI, degree of suffering events, LP code |
| **Michelle Adeyemi** | Paid Media | Google Ads coordination, Domo setup for Google |
| **Kirill** | Tech Lead | Data access gatekeeper (blocked Snowflake/Domo API access) |
| **Alicia** | Performance Tracking | Tracks all paid channel performance in daily steering meetings |
| **Josua Wilms** | Google Ads Contact | Google Ads account discussions |

### Ads on Tap Team

| Person | Role | Relevance |
|--------|------|-----------|
| **Daniel Bulygin** | Managing Director | Strategy, analysis framework, client relationship |
| **Nina Pavlin** | Meta Ads Specialist | Daily campaign management, optimization, creative testing |
| **Aaron Pammer** | Google Ads Specialist | Account restructuring, bid strategy, Quality Score |
| **Franzi Focken** | Co-founder | Creative strategy, metric analysis, creative iteration |
| **Vanessa Straub** | Account Manager | Creative production coordination, client communication |

---

## 12. Open Initiatives & Strategic Priorities (as of Mar 2026)

| Priority | Initiative | Owner | Status |
|----------|-----------|-------|--------|
| **#1** | Lead scoring model (monetary value per lead) | Giancarlo | In progress, delayed 3–4 weeks |
| **#2** | Degree of suffering event in Meta + Google | Dmytro | Deployed on pixel, CAPI being updated |
| **#3** | Landing page A/B testing (LP-first vs direct-to-quiz vs VSL) | Toby + Daniel | Optimizely access secured; pending funnel data |
| **#4** | Google Ads restructuring (granular ad groups, Brand CPC, account separation) | Aaron | In progress |
| **#5** | Full funnel Domo report (click → LPV → quiz → lead → appointment) | Michelle + Dimitro | Requested, not yet built |
| **#6** | CAPI reliability fix | Dmytro | Open — volatile event firing |
| **#7** | New pixel testing (blank pixel alongside legacy) | Nina + Dmytro | Testing phase |
| **#8** | Creative volume scaling to 20/week | Vanessa + Franzi | Operational target |

---

*Last updated: 2026-03-16. Synthesized from 16 Fireflies transcripts spanning Jan 8 – Mar 16, 2026.*
