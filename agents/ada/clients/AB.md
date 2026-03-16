# Audibene (AB) — Operating Context & Methodology

*Knowledge base for Audibene advertising assistant — Last updated: March 2026*

## Communication Style — STRICT, ALWAYS FOLLOW

**HARD LIMIT: Keep responses under 150 words unless the question explicitly asks for a deep analysis.** Short, direct communication only. Violating this degrades trust.

- **Short and sharp.** 2-4 sentences for simple questions. Max 1 short paragraph for complex ones.
- **Talk like a peer, not a report.** You're a senior media buyer in the same room, not writing a deck.
- **NO structure unless asked.** No headers, no bullet lists, no numbered lists, no tables, no emoji flags. Just talk.
- **One insight, not five.** Give the most important thing. They'll ask for more if needed.
- **Numbers inline.** "CR2 dropped to 15.7% this week, main CBO dragging it — the AOT testing CBO is still at 26%, so it's creative/audience in the main camp" — done.
- **No filler.** Never "Let me break this down" or "Here's what I found." Just say it.
- **No caveats about data unless critical.** Don't explain your process. Don't say "I only have X days". Just give the answer. If the data genuinely can't answer the question, say so in one sentence.
- **No honorable mentions, no extras.** Answer the question asked. Stop.

---

## 1. Audibene Business Context

### What Audibene Is

Audibene is a hearing aids manufacturer and direct-to-consumer retailer operating in the DACH region (Germany, Austria, Switzerland). Two brands: **Audibene** (main commercial) and **Hören Heute** (comparison portal / secondary). Revenue ~€200M/year total, ~€80M Germany.

The business model is **lead generation** — hearing aids are not sold online. Meta and Google ads drive users to complete a quiz/questionnaire, after which qualified leads enter a long sales funnel involving phone consultations, in-person appointments (Akustiker), fittings, and purchase. The sales cycle is **3–6 months** from initial lead to closed sale.

### Target Audience

Core audience: **adults aged 55+** with hearing concerns, primarily first-time buyers. Aspirational 50–65+ year-olds (not 80+). Two products: fully in-ear (invisible) and behind-the-ear (stronger processing, noise cancellation).

- Lower digital literacy → landing page simplicity critical
- Higher trust barriers → testimonials, medical credibility, reassurance matter
- Slower scroll behavior, longer content consumption
- Smaller audience pools → frequency management essential
- German Krankenkasse subsidizes up to €1,500 every 5 years for hearing aids

---

## 2. The Full Funnel

```
Ad → Click → Landing Page View → Quiz Start → Quiz Completion (Lead)
  → Net Lead (post auto-close) → Sales Contact (CR2) → First Care Appointment
    → Prescription → Purchase/Sale (CR3 → Revenue)
```

### Funnel Stage Definitions

| Stage | Description | Event |
|-------|-------------|-------|
| **Link Click** | User clicks ad | Standard click |
| **Landing Page View (LPV)** | User reaches LP; LPV share tracked | Meta pixel LPV |
| **Quiz Start** | User begins hearing questionnaire | "First question answered" event |
| **Quiz Completion / Lead** | User provides phone + email | Lead event at phone step |
| **Net Lead** | Passes auto-close filters — **primary Meta optimization event** | Custom `NetLead` |
| **Opportunity** | Sales consultant creates Salesforce record after calling | Salesforce |
| **First Care Appointment** | In-person consultation at Akustiker | Domo/Salesforce |
| **Prescription** | Lead has/receives hearing aid prescription | Domo/Salesforce |
| **Purchase/Sale** | Final hearing aid purchase | Salesforce → CAPI |

### Two Funnel Paths (Meta)

- **Path A — Landing Page First** (default): Ad → LP → CTA → Quiz → Lead. Higher volume, lower quality, higher CPA. Only ~20% of LP visitors click through to quiz.
- **Path B — Direct to Quiz**: Ad → Quiz → Lead. Better quality, lower CPA, higher cost per net lead. Few ads use this.

---

## 3. Conversion Rates (CR1, CR2, CR3)

| Rate | Transition | Benchmarks |
|------|-----------|------------|
| **CR1** | Traffic → Net Lead | ~2.5% net lead CVR (varies by day/LP) |
| **CR2** | Net Lead → First Care Appointment | **Target: 20–25%**, Actual: ~15.7% (Mar), AOT CBO: 26% |
| **CR3** | First Care → Purchase | **Avg: ~25%**, 55–64 cohort: ~20% |

### CR2/CR3 Inverse Correlation (Critical)

- High **first care share** → good CR2 but often **lower CR3**
- High **prescription share** → lower CR2 but **best CR3** (most likely to buy)
- **Optimizing for CR2 alone can hurt CR3 and overall revenue**
- Ideal metric: **CPA adjusted by predicted CR3** (CR2 × CR3 composite)
- Manuel's rule: "If CR3 is less good independent of CPA than other channels, we steer that channel down."

### CR2 Data Completeness

- CR2 depends on sales team contacting leads — no weekend processing
- Zero open leads for a day in Domo → that day's data is complete
- Full picture available **Tuesday morning** (after Monday processing of weekend leads)
- Use Monday-to-Friday windows for reliable analysis

---

## 4. Lead Quality & Scoring

### Quality Buckets (Best to Worst)

1. **Follow-up care** (repeat customer) — strong overall
2. **First care + has prescription** — best for new customers
3. **First care + no prescription** — worst; CR3 particularly low

### Key Lead Attributes

| Attribute | Impact |
|-----------|--------|
| **Degree of Suffering** | Higher = higher CR2 + CR3. "Not at all" = mostly auto-closed. |
| **First Care Share** | Strongest CR2 signal, but may inversely correlate with CR3 |
| **Prescription Share** | Lower CR2 but best purchase predictor (CR3) |
| **Age** | 55–64: higher CVR but CR3 ~20% vs 25% for 65+ |
| **Mobile vs. Landline** | Mobile = more reachable = better CR2 |
| **Age of Current Hearing Aids** | >5–6 years = Krankenkasse subsidy eligible |

### Auto-Close Rules (Pre-CR2)

Leads auto-closed before sales contact: first care + no prescription, "not at all" suffering, certain age groups, excluded zip codes, certain traffic sources.

### Lead Scoring (Highest Priority Initiative)

Current: rule-based negative scoring (auto-close). Target: monetary € value per lead from ~5 weighted variables. Builder: Giancarlo. Enables ROAS bidding on Google + value-based optimization on Meta.

---

## 5. KPIs & Targets

| Metric | Target | Notes |
|--------|--------|-------|
| **CPA (65+)** | **€139** | Primary contractual target |
| **CPA (55–64)** | **~€100** | Adjusted for lower CR3 |
| **CR2** | **20–25%** | 22% conservative realistic |
| **CR3** | **~25%** avg | ~20% for 55–64 |
| **Cost per Purchase** | Ultimate metric | 6-month attribution lag |
| **ROMI** | Ultimate steering metric | What Manuel watches |
| **Daily Meta Budget** | **€2,200** | ±10–20% OK, ±40–50% not OK |
| **Google Monthly** | **€30–40K** | Scalable to €45–60K+ |
| **Frequency** | **1.0–1.05** daily | Higher = saturation |

**CPL is secondary**: "We don't really care about CPL. We care about the appointment and the sale after that."

### Creative Metrics Caveat

Hook rate, hold rate do NOT reliably correlate with Audibene's business KPIs. Steven: "Hold rate and things like that often for us don't correlate that well with our KPIs." Always evaluate creatives on CPA/downstream metrics.

### Low-Quality Tolerance

Steven: 10% of spend on cheap/low-quality leads is acceptable short-term. Don't panic-kill everything with high CPL if total low-quality spend is under 10%.

---

## 6. Tracking Architecture

### Data Pipeline

```
Meta/Google → Landing Page → Quiz → Audibene Backend
  → Salesforce (source of truth) → Snowflake (blocked API)
    → Domo (BI, ~2x daily refresh) ↩ CAPI / Offline Imports
```

### Meta Pixel Events

| Event | Description |
|-------|-------------|
| **event_1, event_2** | Legacy (health category compliance naming) |
| **event_3a, event_3b** | Degree of suffering variants |
| **Questionnaire Started** | Quiz begins ("first question answered") |
| **Net Lead** | Primary optimization event |
| **Lead with Mobile** | Subset; ~70–80% less volume than net leads |

Two pixels: Audibene (main) + Ads on Tap (agency). Events fire on both.

### Key Constraints

1. **Health & Wellness classification** → restricted PII, limited audience building (lookalikes, retargeting)
2. **Google Enhanced Conversions blocked** → can only optimize at lead level
3. **48-hour data lag** → lead quality only available after sales contacts leads
4. **Last-click attribution across ALL channels** → demand-gen looks worse than it is; no cross-channel monitoring
5. **CAPI reliability issues** → volatile event volume (22–300/day vs expected thousands)
6. **iOS Jan 5 disruption** → OTA update degraded LPV share for iOS; Android-only ad sets as workaround
7. **Data attributed to lead creation date**, not opportunity date

---

## 7. Account Structure

### Meta Campaigns

| Campaign Pattern | Type | Notes |
|-----------------|------|-------|
| **AUDIBENE-PROSPECTING-OPEN-CBO** | Main prospecting, open targeting | Workhorse — vast majority of spend |
| **AUDIBENE-PROSPECTING-AOT_TESTING-CBO** | Creative/audience testing | Testing environment; achieves 26% CR2 |
| **AUDIBENE-PROSPECTING-AOT_COSTCAP-CBO** | Cost cap bidding | CPL ceiling enforcement |
| **AUDIBENE-PROSPECTING-AOT_55_64-CBO** | Age-targeted 55–64 | Separate to isolate CR3 impact |
| **AUDIBENE-PROSPECTING-AOT_3A-CBO** | Degree of suffering targeting | "3A" = event_3a (high suffering) |

Naming: `AUDIBENE-[FUNNEL STAGE]-[STRATEGY/TARGETING]-CBO-[OBJECTIVE]-[DATE]`

100% prospecting — no retargeting campaigns (typical for offline-conversion lead-gen).

### Google Ads

- Two accounts: Audibene + Hören Heute (overlapping keywords = Circumventing Systems risk)
- Brand CPC ~€1.80 (target: €0.15–0.50)
- Quality Score 2–9/10; Brand should be 9–10
- Up to 80% Impression Share Lost in some campaigns
- Need: 20–40 ad groups per campaign (currently ~1 broad keyword)

### Domo CSV Exports (Salesforce Data)

Domo is the primary BI dashboard connected to Salesforce. CSV exports are the bridge between Meta data (in-platform) and actual downstream conversions. Two formats:

- **Adview (aggregate)**: 1 row per ad — costs, leads, opportunities, CPL, CPA, CR1, CR2, First Care Share, Prescription Share, Severely Suffering Share
- **Adview By Day**: Same schema + Date column — enables trending, fatigue, day-over-day

Use `pma/tools/audibene_domo.py` in the bmad repo to process these. It parses ad naming conventions and generates creative dimension breakdowns.

### Ad Name Convention (for Domo analysis)

`CREATIVE-FORMAT-RATIO-CREATIVE_ID-CTA-BUTTON-ANGLE-CAMPAIGN_ID`

Example: `PAUL-VIDEO-9x16-VB2939h104b-KAUFEN-LEARN_MORE-PRODUCT-ACT0000095028ACT-080126_PC`

Parseable dimensions: creative type (PAUL), format (VIDEO), ratio (9x16), angle (PRODUCT).

### How to Analyze Domo Data

When processing Domo CSV exports, break down performance by these dimensions (parsed from ad names):

1. **Format** (VIDEO vs IMAGE) — compare CPA and CR2, not just CPL
2. **Aspect Ratio** (9x16, 4x5, 1x1) — different ratios can have dramatically different downstream quality
3. **Angle** (PRODUCT, DIRECT, ZUSCHUSS, ERSTES_HG, FPQ, CONRAD, etc.) — the angle is the strongest predictor of lead quality
4. **Creative Type** (PAUL, DENISE, FORM, NATIVE, etc.) — identifies which creator/concept family performs
5. **Day of week** — weekend vs weekday quality gaps can be massive (sales doesn't work weekends → CR2 data lag + different audience)

**Always evaluate on CPA (cost per appointment), not CPL.** A cheap CPL angle with terrible CR2 wastes money. Cross-reference First Care Share and Prescription Share to assess lead quality beyond CR2.

---

## 8. Performance Contributors

### Positive Levers

- **Degree of suffering optimization** — targeting high-severity leads improves CR2 + CR3
- **Lead scoring** (when ready) — enables ROAS bidding
- **Creative volume** — breakthroughs can halve CPL; target 20/week
- **Landing page testing** via Optimizely (LP-first vs direct-to-quiz vs VSL)
- **Cost/bid cap campaigns** — sit out bad auctions, find cheap lead pockets
- **Monday decision cadence** — complete weekend data for informed steering
- Emotional/vanity messaging > product-focused. Key angles: exclusivity, financial shock, scarcity, technical newness
- Reaction-style single-actor videos (authentic, slow-paced, no music)
- Low frequency (1.0–1.05) = healthy fresh audience

### Negative Contributors

- Meta optimizes for net leads, not appointments — fundamental disconnect
- 48-hour data lag prevents proactive optimization
- Last-click attribution makes demand-gen look bad
- Health category restrictions limit pixel/audience capabilities
- CR2/CR3 inverse correlation — optimizing appointments can hurt purchases
- Meta's CR3 lower than other channels — channel allocation at stake
- 55–64 targeting: higher CVR but CR3 20% vs 25%
- Click-baity ads: good CPL but terrible CPA
- Audience saturation in 65+ Germany (finite pool)
- CAPI inconsistency through Salesforce → Snowflake pipeline

---

## 9. Analysis Framework

### Drill-Down Methodology

1. Identify which metric dropped (CPL, CR2, CPA, CR3)
2. Drill down: Campaign → Ad set → Ad level
3. Identify the specific ad/ad set causing the drop
4. Investigate root cause (audience, creative, bid strategy, tracking)
5. Take action on root cause — never just report observation

### Key Principles

- CPM increases alone NOT diagnostic — good weeks happen with higher CPMs
- 7% CR2 = kill campaign immediately
- Lower CR1 OK if CR2 compensates (testing campaign pattern)
- Weekend data unreliable — use Mon–Fri windows
- Creative engagement ≠ business KPIs for Audibene
- Quick CPA calc: Total Spend ÷ Opportunities
- Always cross-validate Meta vs Domo/CRM before big decisions
- Forecasts rarely correlate with actual — focus on directional trends

---

## 10. Alert Thresholds

### Metric Alerts

| Alert | Threshold |
|-------|-----------|
| **CPA Spike** | +25% above target (€174 for 65+, €125 for 55–64) |
| **CR2 Drop** | Below 15% (kill threshold: 7%) |
| **CPM Spike** | +25% above benchmark |
| **Frequency High** | >3.5 (audience fatigue) |
| **Lead Rate Drop** | -20% below benchmark |

### Budget Alerts

- Over target by 20%+ → flag (Steven wants ±10–20% max)
- Under target by 20%+ → flag with plan

### Outlier Detection

- Ad with ≥10 leads and CPL ≤ €10 → potential tracking anomaly
- Ad spending €200+ with zero conversions → review
- Deviation warning: 15% from expected; critical: 25%

---

## 11. Key People

### Audibene

| Person | Role |
|--------|------|
| **Steven Roberts** | Channel Manager, Paid Social — main contact |
| **Manuel Stegmann** | Head of Growth — strategy, budget, ROMI |
| **Tobias/Toby** | Head of Growth Tech — Optimizely, LP infra |
| **Giancarlo** | Data Analyst — lead scoring, auto-close, CR analysis |
| **Dmytro/Dimitro** | Developer — pixel, CAPI, events |
| **Michelle Adeyemi** | Google Ads coordination, Domo |
| **Kirill** | Tech Lead — data access gatekeeper |
| **Alicia** | Performance Tracking — tracks all paid channel performance in daily steering meetings |

### Ads on Tap

| Person | Role |
|--------|------|
| **Nina Pavlin** | Meta Ads — daily optimization |
| **Aaron Pammer** | Google Ads — restructuring, bid strategy |
| **Vanessa Straub** | Account Manager — creative production |
| **Daniel Bulygin** | Strategy, analysis, client relationship |
| **Franzi Focken** | Creative strategy, metric analysis |

---

## 12. Comparison Periods

| Timeframe | Current | Compare Against |
|-----------|---------|-----------------|
| **Short-term** | Last 3 days | Previous 7 days |
| **Medium-term** | Last 7 days | Previous 14 and 30 days |
| **Long-term** | Last 30 days | Previous 60 and 90 days |

---

## 13. Markets

| Market | Code | Priority |
|--------|------|----------|
| **Germany** | DE | Primary |
| **Austria** | AT | Secondary |
| **Switzerland** | CH | Secondary |

Country code alert: DE ≠ DK, AT ≠ AU, CH ≠ CN. Any spend in DK/AU/CN = targeting error. Flag at €50.

---

## 14. Strategic Initiatives (as of Mar 2026)

| Priority | Initiative | Owner | Status |
|----------|-----------|-------|--------|
| #1 | Lead scoring model (monetary € value per lead) | Giancarlo | In progress, delayed 3-4 weeks |
| #2 | Degree of suffering event in Meta + Google | Dmytro | Deployed on pixel, CAPI being updated |
| #3 | LP A/B testing (LP-first vs direct-to-quiz vs VSL) | Toby + Daniel | Optimizely access secured |
| #4 | Google Ads restructuring (granular ad groups, brand CPC) | Aaron | In progress |
| #5 | Full funnel Domo report (click → LPV → quiz → lead → appointment) | Michelle + Dmytro | Requested, not yet built |
| #6 | CAPI reliability fix | Dmytro | Open — volatile event firing |
| #7 | New pixel testing (blank pixel alongside legacy) | Nina + Dmytro | Testing phase |
| #8 | Creative volume scaling to 20/week | Vanessa + Franzi | Operational target |

---

## 15. Weekly Health Checks (Monday)

1. **Budget pacing** — Is spend tracking to €2,200/day? Flag if >20% off.
2. **CPA check** — Pull Domo data (or Meta if unavailable). CPA vs €139 target.
3. **CR2 check** — Only Mon-Fri data valid. Tuesday morning = complete picture of prior week. Flag if <20%.
4. **Frequency** — Any campaigns/ad sets >1.05 daily average? Creative refresh needed.
5. **Placement distribution** — Any placement eating disproportionate budget at poor efficiency?
6. **Country audit** — 100% of spend in DE/AT/CH. Flag any outside DACH.
7. **Age breakdown** — Confirm spend reaching 55+. Significant budget to under-45 = targeting issue.
8. **Lead quality** — Compare Net Leads vs total leads. If ratio deteriorates, quality is dropping even if CPL looks stable.
9. **Creative fatigue** — Declining hook rates on high-spend ads running 14+ days.
