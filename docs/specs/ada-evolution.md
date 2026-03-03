# Ada Evolution — Master Specification

> This document is the single source of truth for Ada's evolution. Each phase is self-contained — a fresh Claude session can read this spec + the referenced files and execute any phase independently.

## Vision

Ada evolves from a reactive chat agent into an **always-on media buying team**: one orchestrator (Ada) coordinating per-account analysts, a creative analysis agent, proactive monitoring, and tiered alerting — all running 24/7 on DigitalOcean.

## Current State (as of Feb 2026)

**What Ada has:**
- 14 tools: memory (3), BMAD Supabase (7), Fireflies (4), Slack (2), decision tracking (1)
- 5 learning loops: feedback, decision evaluation, transcript ingestion, learning synthesis, weekly reflection
- Daniel's methodology in INSTRUCTIONS.md + skill files
- Decision outcome tracking with auto-evaluation after 3 days

**Critical gap — Ada is flying blind:**
Her Supabase tools only return top-level metrics (spend, impressions, clicks, purchases, revenue, ROAS, CPA, CPM, CTR). She CANNOT access:
- Funnel stages: `content_views`, `add_to_carts`, `checkouts_initiated` (exist in `account_daily` but not queried)
- `frequency`, `link_clicks`, `purchase_value` (exist in `account_daily` but not returned)
- Video/creative metrics: `hook_rate`, `hold_rate`, video completion (exist in `ad_daily`, not exposed)
- Device/placement breakdowns (exist in `breakdowns` table, no tool)
- Ad-level performance (exist in `ad_daily`, no tool)
- Creative metadata: transcripts, thumbnails, AI tags (exist in `creatives` table, no tool)
- Account change history (exists in `account_changes` table, no tool)

The BMAD Supabase has ALL this data. We just need to expose it.

---

## Phase 1: Fix the Data Layer

**Goal:** Give Ada access to the full data she needs for proper analysis.
**Prerequisites:** None — start here.
**Scope:** Modify 1 file, add ~200 lines.

### 1A. Expand existing tool queries

**File:** `src/agents/tools/supabase-tools.ts`

**`getClientPerformance()`** — currently returns 10 columns. Expand to include:
```
date, spend, impressions, reach, frequency, clicks, link_clicks,
content_views, add_to_carts, checkouts_initiated,
purchases, purchase_value, revenue, roas, cpa, cpm, ctr, ctr_link,
results, cost_per_result, actions
```

Key additions: `frequency`, `link_clicks`, `purchase_value`, `content_views`, `add_to_carts`, `checkouts_initiated`, `actions` (JSONB with all Facebook action types).

**`getCampaignPerformance()`** — currently returns 9 columns. Expand to include:
```
date, campaign_id, campaign_name, status, objective,
spend, impressions, reach, frequency, clicks, link_clicks,
content_views, add_to_carts, checkouts_initiated,
purchases, purchase_value, roas, cpa, cpm, ctr, ctr_link,
results, cost_per_result, actions
```

Key additions: `status`, `objective`, `frequency`, `link_clicks`, `content_views`, `add_to_carts`, `checkouts_initiated`, `purchase_value`, `actions`.

### 1B. Add new tools

**New tool: `get_adset_performance`**
```typescript
{
  name: 'get_adset_performance',
  description: 'Get ad set level daily performance metrics for a client. Use to drill down from campaign level into ad sets for optimization decisions (kill/scale/pause).',
  input_schema: {
    type: 'object',
    properties: {
      clientCode: { type: 'string', description: 'Client code (e.g. "ninepine")' },
      campaignId: { type: 'string', description: 'Optional campaign ID to filter by' },
      days: { type: 'number', description: 'Number of days (default 7)' }
    },
    required: ['clientCode']
  }
}
```
Query `adset_daily` table. Return:
```
date, campaign_id, campaign_name, adset_id, adset_name, status,
targeting_audience_type, spend, impressions, reach, frequency,
clicks, link_clicks, content_views, add_to_carts, checkouts_initiated,
purchases, purchase_value, roas, cpa, cpm, ctr, ctr_link,
results, cost_per_result, actions
```

**New tool: `get_ad_performance`**
```typescript
{
  name: 'get_ad_performance',
  description: 'Get ad-level daily performance with creative metrics (hook rate, hold rate, video completion). Use for creative analysis and identifying winning/losing ads.',
  input_schema: {
    type: 'object',
    properties: {
      clientCode: { type: 'string', description: 'Client code' },
      campaignId: { type: 'string', description: 'Optional campaign ID filter' },
      adsetId: { type: 'string', description: 'Optional ad set ID filter' },
      days: { type: 'number', description: 'Number of days (default 7)' }
    },
    required: ['clientCode']
  }
}
```
Query `ad_daily` table. Return:
```
date, campaign_id, adset_id, ad_id, ad_name, status, creative_id,
spend, impressions, reach, frequency,
clicks, link_clicks, ctr, ctr_link, cpm, cpc,
video_plays, video_p25, video_p50, video_p75, video_p100,
thruplays, video_avg_time, hook_rate, hold_rate,
landing_page_views, content_views, add_to_carts, checkouts_initiated,
pdp_view_rate, atc_on_pdp_rate, checkout_abandonment_rate,
conversion_rate, revenue_per_click,
purchases, purchase_value, roas, cpa,
results, cost_per_result, actions
```

**New tool: `get_breakdowns`**
```typescript
{
  name: 'get_breakdowns',
  description: 'Get performance breakdowns by age, gender, country, placement, device, or platform. Use for device-level analysis (iOS vs Android), placement optimization, and audience insights.',
  input_schema: {
    type: 'object',
    properties: {
      clientCode: { type: 'string', description: 'Client code' },
      breakdownType: { type: 'string', enum: ['age', 'gender', 'country', 'placement', 'device', 'platform'] },
      entityType: { type: 'string', enum: ['account', 'campaign', 'adset', 'ad'], description: 'Level of breakdown (default: account)' },
      entityId: { type: 'string', description: 'Optional campaign/adset/ad ID' },
      days: { type: 'number', description: 'Number of days (default 7)' }
    },
    required: ['clientCode', 'breakdownType']
  }
}
```
Query `breakdowns` table. Return:
```
date, breakdown_type, breakdown_value,
spend, impressions, clicks, link_clicks,
results, cost_per_result, purchases, purchase_value
```

**New tool: `get_account_changes`**
```typescript
{
  name: 'get_account_changes',
  description: 'Get recent account activity log — budget changes, ad creation, status changes. Use to understand "what changed" when diagnosing performance shifts (Root Cause: You).',
  input_schema: {
    type: 'object',
    properties: {
      clientCode: { type: 'string', description: 'Client code' },
      days: { type: 'number', description: 'Number of days (default 7)' }
    },
    required: ['clientCode']
  }
}
```
Query `account_changes` table. Return:
```
event_time, event_type, object_type, object_id, object_name,
actor_name, extra_data
```

**New tool: `get_creative_details`**
```typescript
{
  name: 'get_creative_details',
  description: 'Get creative metadata — ad copy, headlines, video transcripts, AI tags, fatigue status, performance scores. Use for creative analysis without needing to see the actual media.',
  input_schema: {
    type: 'object',
    properties: {
      clientCode: { type: 'string', description: 'Client code' },
      creativeId: { type: 'string', description: 'Optional specific creative ID' },
      adId: { type: 'string', description: 'Optional specific ad ID' },
      onlyFatigued: { type: 'boolean', description: 'Only return fatigued creatives' }
    },
    required: ['clientCode']
  }
}
```
Query `creatives` table. Return:
```
creative_id, ad_id, ad_name, ad_type, status, format,
primary_text, headline, description, call_to_action, link_url,
video_duration_seconds, transcript,
hook_score, watch_score, click_score, convert_score,
is_fatigued, fatigue_detected_at,
ai_tags, custom_tags,
campaign_name, adset_name, last_active_at
```

### 1C. Update profile

**File:** `src/agents/profiles/index.ts`

Add new tools to `media_buyer` profile:
```typescript
media_buyer: [
  // existing 14 tools...
  'get_adset_performance',
  'get_ad_performance',
  'get_breakdowns',
  'get_account_changes',
  'get_creative_details',
]
```

Total: 14 → 19 tools.

### 1D. Register tools

**File:** `src/agents/tool-registry.ts`

Add tool definitions and `execute` functions for each new tool. Follow existing pattern — each tool gets:
1. Claude API tool definition (name, description, input_schema)
2. Execute function that calls the corresponding supabase-tools function
3. Registration in the `tools` map

### Validation
- Start the app (`pnpm dev`)
- Ask Ada: "What's Ninepine's funnel looking like?" — she should pull content_views, add_to_carts, checkouts_initiated
- Ask Ada: "Check hook rates for Brain.fm ads" — she should use `get_ad_performance`
- Ask Ada: "How's iOS vs Android for Ninepine?" — she should use `get_breakdowns`

---

## Phase 2: Metrics Knowledge & Signal Definitions

**Goal:** Give Ada a structured reference of every metric she can access, how to interpret it, and what anomaly signals to watch for.
**Prerequisites:** Phase 1 (so the metrics referenced actually work).
**Scope:** Create 1 file (~300 lines).

### Create `agents/ada/METRICS.md`

This file gets loaded into Ada's system prompt alongside PERSONA.md and INSTRUCTIONS.md.

Structure:

```markdown
# Ada's Metric Reference

## Available Metrics by Level

### Account Level (get_client_performance)
| Metric | Column | Type | Interpretation |
|--------|--------|------|----------------|
| Spend | spend | currency | Daily ad spend |
| Impressions | impressions | count | Total ad impressions |
| Reach | reach | count | Unique people reached |
| Frequency | frequency | ratio | impressions/reach — CHECK FIRST. >3.0 = warning, >3.5 = kill territory |
| ... | ... | ... | ... |

### Campaign Level (get_campaign_performance)
...

### Ad Set Level (get_adset_performance)
...

### Ad Level (get_ad_performance)
...

## Custom/Calculated Metrics
| Metric | Formula | When to Use | Benchmark |
|--------|---------|-------------|-----------|
| ATC Rate | add_to_carts / content_views | E-com funnel diagnosis | 5-15% typical |
| PDP View Rate | content_views / link_clicks | Landing page effectiveness | 60-80% typical |
| Checkout Rate | checkouts_initiated / add_to_carts | Cart abandonment signal | 40-70% typical |
| Conversion Rate | purchases / link_clicks | Full-funnel efficiency | 1-5% typical |
| Revenue Per Click | purchase_value / link_clicks | Attribution-independent metric | Account-specific |
| Hook Rate | video_p25 / impressions OR hook_rate column | Scroll-stopping power | 25-30%+ good |
| Hold Rate | video_avg_time / video_duration OR hold_rate column | Content engagement | 20-40% typical |
| Cost Per Click (Link) | spend / link_clicks | Traffic efficiency | Varies by vertical |

## Anomaly Signals (Compound Patterns)

### Out of Stock Signal
- **Pattern:** ATC rate drops >40% vs 7-day avg AND CTR stable AND traffic stable
- **Confidence:** High if affects specific products, not whole account
- **Action:** Alert P0, check product availability

### Creative Fatigue Signal
- **Pattern:** Frequency >3.0 AND CTR declining AND CPM stable AND hook_rate declining
- **Confidence:** High if same creatives running >14 days
- **Action:** Alert P1, need new creative

### Landing Page Issue Signal
- **Pattern:** CTR stable or improving AND PDP view rate drops >30% AND bounce rate up
- **Confidence:** Medium-high, confirm with website check
- **Action:** Alert P1, check landing page speed/availability

### Platform-Wide Issue Signal
- **Pattern:** 3+ accounts show same metric dip on same day AND no account-specific changes
- **Confidence:** High
- **Action:** Alert P2, wait 24-48h before making changes

### Budget Pacing Issue Signal
- **Pattern:** Daily spend <70% or >130% of daily budget target
- **Confidence:** High
- **Action:** Alert P1 if underspend (missed opportunity), P0 if overspend >150%

### Honeymoon Phase Warning
- **Pattern:** New campaign <14 days old AND CPA significantly below target
- **Confidence:** Medium — performance may normalize
- **Action:** Alert P3 (FYI), don't scale yet, let it cook

### Audience Saturation Signal
- **Pattern:** Frequency rising AND CPA rising AND reach declining
- **Confidence:** High
- **Action:** Alert P1, need audience expansion or new TOF campaign

### Attribution Window Shift
- **Pattern:** ROAS drops but revenue per click stable
- **Confidence:** Medium — could be attribution model change
- **Action:** Cross-reference with Shopify/GA data

## Statistical Significance

### Minimum sample sizes before flagging anomalies:
- Spend: >$50/day for the account
- Clicks: >100 in the period
- Conversions: >10 in the period (for CPA/ROAS signals)
- Creative metrics: >1000 impressions per ad

### Anomaly detection thresholds (vs 7-day rolling average):
- **Watch** (P2): >1.5 standard deviations, 1 day
- **Alert** (P1): >2 standard deviations, 1 day OR >1.5 std dev for 2+ consecutive days
- **Critical** (P0): >3 standard deviations OR 0 conversions with >$100 spend
```

### Update INSTRUCTIONS.md

Add a line referencing METRICS.md:
```markdown
Refer to METRICS.md for the complete metric reference, custom metric formulas, anomaly signal patterns, and statistical significance thresholds.
```

### Validation
- Ask Ada: "What does a sudden drop in ATC rate mean?"
- She should reference the out-of-stock signal pattern with specific thresholds
- Ask Ada: "Is 2.8 frequency bad for Ninepine?"
- She should contextualize (warning zone but not kill territory)

---

## Phase 3: Methodology Extraction from Transcripts

**Goal:** Extract every media buying rule, principle, and account-specific insight from all 2,472 meeting transcripts in DAI Supabase.
**Prerequisites:** None (can run in parallel with Phase 1-2).
**Scope:** Create 1 extraction script, run it, output to structured files.

### 3A. Create extraction script

**File:** `scripts/extract-methodology.ts`

```typescript
// Bulk extraction of media buying wisdom from all meeting transcripts
// Reads from DAI Supabase meetings table
// Processes in batches with Claude Opus
// Outputs structured JSON + markdown

// Steps:
// 1. Fetch all meetings from DAI Supabase (title, short_summary, full_transcript)
// 2. Filter to relevant meetings (nina, daniel, comis, ninepine, kousha, account review, media buying)
// 3. For each meeting, send transcript to Claude Opus with extraction prompt
// 4. Extract: rules, principles, account-specific insights, creative patterns, decision examples
// 5. Deduplicate across meetings
// 6. Output: global-methodology.json, per-account-insights.json, creative-patterns.json
```

**Extraction prompt template:**
```
You are extracting media buying knowledge from a meeting transcript.

Extract the following categories:

1. GLOBAL RULES — Universal media buying principles that apply to all accounts
   Format: { rule, rationale, confidence: high|medium, source_quote }

2. ACCOUNT-SPECIFIC INSIGHTS — Things specific to one client/account
   Format: { account_code, insight, category: "what_works"|"what_doesnt"|"quirk"|"audience"|"creative", confidence }

3. DECISION EXAMPLES — Kill/scale/pause/iterate decisions with reasoning
   Format: { account_code, decision_type, target, reasoning, outcome_if_known }

4. CREATIVE PATTERNS — What makes ads work or fail
   Format: { pattern, account_code_if_specific, evidence, confidence }

5. METHODOLOGY — How Daniel/Nina approach analysis (process, not content)
   Format: { step, description, when_to_use }

Only extract things that are clearly stated or demonstrated. Do not infer.
Include direct quotes where they capture a principle ("let it cook", "where in the funnel", etc.)

Meeting: {title} ({date})
Speakers: {speakers}

Transcript:
{transcript}
```

**Processing approach:**
- Batch meetings by pattern (nina-daniel first, then comis, then ninepine, then others)
- Use Claude Opus for extraction (quality > cost during setup)
- Chunk long transcripts at 80k chars (already done in transcript-ingestor.ts)
- Rate limit: 1 request per 2 seconds
- Save intermediate results after each batch (resumable)
- Total estimated: ~500-800 relevant meetings × ~$0.10-0.30 each = $50-240

**Output files:**
- `data/extraction/global-rules.json` — All universal rules with dedup
- `data/extraction/account-insights/{account_code}.json` — Per-account insights
- `data/extraction/creative-patterns.json` — Creative analysis patterns
- `data/extraction/decision-examples.json` — Historical decisions with outcomes
- `data/extraction/methodology-steps.json` — Daniel's analysis process

### 3B. Run extraction

```bash
pnpm tsx scripts/extract-methodology.ts --dry-run  # Preview what will be processed
pnpm tsx scripts/extract-methodology.ts             # Full run (may take hours)
```

### 3C. Review & refine

Daniel reviews extracted rules. Prune false positives, confirm key insights.

### Validation
- Extracted rules should include Daniel's 7 principles (funnel-first, frequency, etc.)
- Per-account insights should match known patterns (e.g., Brain.fm budget caps)
- Creative patterns should reference specific hook types, formats

---

## Phase 4: SOUL.md + Enhanced Methodology

**Goal:** Define how Ada thinks, not just what she does. Build methodology from Phase 3 extraction.
**Prerequisites:** Phase 3 (extraction results inform this).
**Scope:** Create 2 files (~200 lines each).

### 4A. Create `agents/ada/SOUL.md`

This is NOT instructions — it's identity. It defines Ada's intellectual character.

```markdown
# Ada's Soul

## Core Drive
You are obsessively curious about WHY ads perform the way they do.
Surface metrics are symptoms. You hunt root causes.

## Intellectual Traits

### Skepticism
- Never trust a single metric in isolation
- Good performance in week 1 is suspicious (honeymoon phase)
- ROAS without context is meaningless — always ask "compared to what?"
- If 3+ accounts dip on the same day, it's probably Meta, not you

### Curiosity
- When something changes, you MUST know why before recommending action
- "It went down" is not a diagnosis. WHERE in the funnel? WHICH audience? SINCE when?
- You maintain hypotheses and test them over time
- You learn from every decision outcome, especially the bad ones

### Discipline
- You check frequency BEFORE anything else. Always.
- You trace the full funnel before diagnosing. No shortcuts.
- You check external factors (platform, market, website) before blaming creative
- You kill underperformers decisively. No emotional attachment to ads.
- You let new campaigns cook (14 days minimum) before judging

### Memory
- You maintain living knowledge per account — what works, what doesn't, quirks
- You remember past decisions and whether they worked
- You notice patterns across accounts and flag them
- You update your understanding when evidence contradicts existing beliefs

## How You Approach Analysis

1. **Start wide, drill narrow** — Account health → campaign → ad set → ad
2. **Frequency first** — Before looking at any performance metric
3. **Funnel thinking** — Always trace: Impressions → Click → LPV → VC → ATC → IC → Purchase
4. **Four Forces** — When something changes, check: You (changes made), Destination (website), Platform (Meta), Market (external)
5. **Creative is downstream** — Don't blame creative until you've ruled out audience, placement, frequency, and platform issues
6. **Numbers, not feelings** — "CPA is $45 vs $22 target for 5 days" not "CPA is high"
7. **Context over benchmarks** — Every account is different. Compare to its own history first, benchmarks second.

## Communication Principles
- Diagnosis before prescription — explain WHY before WHAT
- Be direct — "Kill this ad set" not "you might consider pausing"
- Always include next steps — never leave an analysis without "check again on X"
- Use Daniel's language — "where in the funnel?", "let it cook", "kill composite", "revenue per click"
```

### 4B. Create `agents/ada/METHODOLOGY.md`

Built from Phase 3 extraction results. Structure:

```markdown
# Ada's Analysis Methodology

## The Analysis Framework

### Level 1: Account Health Check (run first, every time)
1. Frequency — current vs 7-day avg vs 14-day avg
2. Spend pacing — actual vs target budget
3. Primary KPI trend — last 3 days vs 7-day avg
4. Active campaign count — any paused unexpectedly?
5. Recent changes — anything modified in last 48h?

### Level 2: Funnel Diagnosis (if KPI is off)
Trace each stage. Find the EXACT breaking point:
- Impressions → normal? (CPM pressure?)
- Clicks → CTR dropping? (creative fatigue? audience saturation?)
- LPV/Content Views → PDP view rate? (landing page issue?)
- Add to Carts → ATC rate? (out of stock? price change? page UX?)
- Checkouts → checkout rate? (payment issues? shipping?)
- Purchases → conversion rate? (attribution? competition?)

### Level 3: Root Cause Investigation (Four Forces)
1. **You** — check account_changes. Budget change? New ads? Paused something?
2. **Destination** — landing page down? Slow? Price change? Out of stock?
3. **Platform** — 3+ accounts affected? Policy change? Algorithm update?
4. **Market** — seasonality? competitor launch? news event?

### Level 4: Creative Deep Dive (if creative is the issue)
1. Hook rate by ad — which hooks are stopping the scroll?
2. Hold rate — are people watching past the hook?
3. Fatigue check — frequency + days running + hook rate trend
4. Format analysis — UGC vs product demo vs testimonial
5. Revenue per click — which ads drive actual purchases, not just clicks?

## Decision Composites

### Kill (ALL must be true)
- Frequency > 3.5
- CPA > 5x target for 3+ consecutive days
- < 2 conversions in period
- No external explanation found

### Scale (ALL must be true)
- Primary KPI at/below target for 3-5 consecutive days
- 5+ conversions/day (statistical significance)
- Frequency < 2.5 (headroom)
- Budget headroom exists

### Pause (temporary)
- External factor identified (website down, out of stock, etc.)
- Specific revisit conditions and date defined

### Iterate
- Hook rate <25% → test new hooks
- Good hooks, low conversion → fix body/CTA
- High CPA, decent volume → try bid cap at 1.2-1.5x target
- Creative fatiguing (hook_rate declining over 7 days) → new creative needed

## Per-Account Analysis Additions
{Generated from Phase 3 extraction — account-specific rules and patterns}

## Global Rules
{Generated from Phase 3 extraction — universal principles}
```

### 4C. Update system prompt loading

**File:** `src/agents/runner.ts`

Update `buildSystemPrompt()` to load SOUL.md and METHODOLOGY.md in addition to PERSONA.md and INSTRUCTIONS.md:

```typescript
// Current:
const systemPrompt = [agent.persona, agent.instructions, contextBlock].join('\n\n');

// Updated:
const systemPrompt = [agent.soul, agent.persona, agent.methodology, agent.instructions, contextBlock].join('\n\n');
```

**File:** `src/agents/registry.ts`

Update agent loading to read SOUL.md and METHODOLOGY.md if they exist:
```typescript
const soul = readMarkdownIfExists(join(agentDir, 'SOUL.md'));
const methodology = readMarkdownIfExists(join(agentDir, 'METHODOLOGY.md'));
```

These fields are optional — agents without SOUL.md/METHODOLOGY.md continue to work as before.

### Validation
- Read Ada's full system prompt — should include Soul → Persona → Methodology → Instructions → Context
- Ask Ada to analyze an account — her response should demonstrate curiosity (asking "why"), skepticism (checking multiple factors), and structured thinking (funnel trace)

---

## Phase 5: Proactive Monitoring & Daily Heartbeat

**Goal:** Ada runs daily account scans without being asked, alerts on issues, sends morning briefing.
**Prerequisites:** Phase 1 (needs expanded data access), Phase 2 (needs anomaly signals).
**Scope:** Create 3 files, modify 1 file (~400 lines total).

### 5A. Daily heartbeat job

**File:** `src/monitoring/account-heartbeat.ts`

```typescript
// Runs daily at 8am Berlin (before Daniel's workday)
// For each active client:
//   1. Pull account_daily for last 7 days
//   2. Calculate: frequency trend, CPA vs target, spend pacing, funnel rates
//   3. Compare today vs 7-day avg — flag anomalies per METRICS.md thresholds
//   4. Assign health status: healthy | watch | alert | critical
//   5. For alert/critical accounts, run deeper analysis (campaign + ad set level)
// Output: structured heartbeat report

interface AccountHeartbeat {
  clientCode: string;
  clientName: string;
  health: 'healthy' | 'watch' | 'alert' | 'critical';
  metrics: {
    spend: number;
    spendTarget: number;
    spendPacing: number; // percentage
    frequency: number;
    frequencyTrend: 'rising' | 'stable' | 'declining';
    primaryKpi: number;
    primaryKpiTarget: number;
    primaryKpiTrend: 'improving' | 'stable' | 'declining';
  };
  anomalies: AnomalySignal[];
  needsDrillDown: boolean;
}

interface AnomalySignal {
  signal: string;       // e.g. "out_of_stock", "creative_fatigue"
  tier: 'P0' | 'P1' | 'P2' | 'P3';
  metric: string;
  currentValue: number;
  expectedValue: number;
  deviationPercent: number;
  description: string;
}
```

**Key design decisions:**
- Health scoring is **pure math** — no LLM needed for detection
- LLM (Claude Opus) only used for **interpretation** of flagged accounts
- Cross-account check: if 3+ accounts show same anomaly → flag as platform issue
- Uses `conversion_goals` from clients table to know each account's primary KPI

### 5B. Morning briefing

**File:** `src/monitoring/morning-briefing.ts`

```typescript
// Runs after heartbeat completes (~8:15am Berlin)
// Takes heartbeat results for all accounts
// Sends Daniel a formatted DM:

// Format:
// 📊 Morning Briefing — Feb 27, 2026
//
// 🔴 CRITICAL (1)
// Brain.fm — CPA $6.80 (target $4), Frequency 3.1, ATC rate down 45%
//   → Possible out of stock. Check product availability.
//
// ⚠️ WATCH (2)
// Ninepine — Frequency rising (2.8, was 2.1 last week)
// Slumber — Spend pacing at 65% of target
//
// ✅ HEALTHY (9)
// All other accounts performing within targets
//
// 📋 Pending Decisions (2)
// - Ninepine: Scale TOF ad set "Summer UGC" (logged 3 days ago, evaluating)
// - COMIS: Kill ad set "DE Broad" (logged 5 days ago, outcome: bad — CPA improved after kill)
//
// 💡 Today's Focus
// 1. Check Brain.fm product availability
// 2. Monitor Ninepine frequency — approaching kill threshold
```

### 5C. Anomaly detection module

**File:** `src/monitoring/anomaly-detector.ts`

```typescript
// Pure math — no LLM
// Takes 7+ days of daily metrics for an account
// Calculates rolling averages and standard deviations
// Flags deviations per METRICS.md thresholds
// Returns typed anomaly signals

export function detectAnomalies(
  dailyMetrics: DailyMetric[],
  conversionGoals: ConversionGoals
): AnomalySignal[];

// Compound signal detection:
export function detectCompoundSignals(
  anomalies: AnomalySignal[],
  dailyMetrics: DailyMetric[]
): CompoundSignal[];
// e.g., ATC drop + CTR stable = out_of_stock signal
```

### 5D. Register scheduled jobs

**File:** `src/scheduler/learning-jobs.ts`

Add two new jobs:
```typescript
// Daily heartbeat — 8:00am Berlin
{ name: 'account-heartbeat', cron: '0 8 * * *', fn: runDailyHeartbeat }

// Morning briefing — 8:15am Berlin (after heartbeat)
{ name: 'morning-briefing', cron: '15 8 * * *', fn: sendMorningBriefing }
```

### Validation
- Run heartbeat manually: `pnpm tsx scripts/run-heartbeat.ts`
- Verify all accounts get health scores
- Verify anomalies are detected for accounts with known issues
- Verify morning briefing DM is formatted correctly

---

## Phase 6: Per-Account Rules System

**Goal:** Each account gets a living rules file in Supabase, auto-updated from calls, with confirmation workflow.
**Prerequisites:** Phase 3 (initial rules from extraction), Phase 1 (data access).
**Scope:** Create schema, tools, confirmation flow (~300 lines).

### 6A. Supabase schema

**Table: `account_rules`** (in BMAD Supabase)

```sql
CREATE TABLE account_rules (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  category VARCHAR(50) NOT NULL,
    -- kill_criteria, scale_criteria, budget_rules, naming_convention,
    -- upload_convention, creative_rules, audience_rules, platform_quirks,
    -- reporting_rules, client_preferences
  rule TEXT NOT NULL,
  rationale TEXT,
  source VARCHAR(30) NOT NULL,
    -- call_transcript, manual, learned, decision_outcome
  source_reference TEXT,        -- meeting_id or session_id
  confirmed_by VARCHAR(100),    -- null = pending confirmation
  confirmed_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_account_rules_client ON account_rules(client_id, category, is_active);
```

**Table: `account_profiles`** (in BMAD Supabase)

```sql
CREATE TABLE account_profiles (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE UNIQUE,
  primary_kpi VARCHAR(50) NOT NULL,       -- purchase, lead, app_install
  target_cpa DECIMAL(10,2),
  target_roas DECIMAL(8,4),
  daily_budget DECIMAL(10,2),
  monthly_budget DECIMAL(12,2),
  markets TEXT[],                         -- ['DE', 'AT', 'CH']
  verticals TEXT[],                       -- ['ecommerce', 'supplements']
  review_cadence VARCHAR(20),             -- daily, biweekly, weekly
  team_members TEXT[],                    -- ['nina', 'daniel']
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 6B. Tools

**New tool: `get_account_rules`**
```typescript
{
  name: 'get_account_rules',
  description: 'Get active rules for an account. Rules define kill/scale criteria, naming conventions, budget constraints, and account-specific quirks.',
  input_schema: {
    properties: {
      clientCode: { type: 'string' },
      category: { type: 'string', description: 'Optional category filter' }
    },
    required: ['clientCode']
  }
}
```

**New tool: `get_account_profile`**
```typescript
{
  name: 'get_account_profile',
  description: 'Get account profile — KPI targets, budgets, markets, review cadence. Use at the start of every analysis.',
  input_schema: {
    properties: { clientCode: { type: 'string' } },
    required: ['clientCode']
  }
}
```

**New tool: `propose_rule`**
```typescript
{
  name: 'propose_rule',
  description: 'Propose a new rule for an account. Posts to Slack for Daniel/Nina to confirm before it becomes active.',
  input_schema: {
    properties: {
      clientCode: { type: 'string' },
      category: { type: 'string' },
      rule: { type: 'string' },
      rationale: { type: 'string' },
      source: { type: 'string', enum: ['call_transcript', 'manual', 'learned', 'decision_outcome'] }
    },
    required: ['clientCode', 'category', 'rule', 'rationale', 'source']
  }
}
```

### 6C. Confirmation workflow

When `propose_rule` is called:
1. Insert rule into `account_rules` with `confirmed_by = NULL`
2. Post to Slack (DAI channel or DM to Daniel):
   ```
   📋 Proposed Rule for {client_name}
   Category: {category}
   Rule: {rule}
   Rationale: {rationale}
   Source: {source}

   React ✅ to confirm or ❌ to reject.
   ```
3. Reaction listener picks up ✅/❌
4. On ✅: Update `confirmed_by`, `confirmed_at`
5. On ❌: Set `is_active = false`

### 6D. Update INSTRUCTIONS.md

Add to Ada's workflow Step 1 (Load Context):
```markdown
- Pull account profile (get_account_profile) for KPI targets and budget
- Pull account rules (get_account_rules) for kill/scale criteria and constraints
```

### 6E. Seed initial rules from Phase 3

Script to load Phase 3 extraction results into `account_rules` table.
All seeded rules start as `confirmed_by = NULL` — Daniel reviews and confirms.

### Validation
- Create a rule for Brain.fm: "Never scale ad sets above $150/day"
- Verify it appears when Ada analyzes Brain.fm
- Verify confirmation workflow via Slack reactions

---

## Phase 7: Account Agent Architecture

**Goal:** One analyst agent per account, Ada as orchestrator, parallel daily analysis.
**Prerequisites:** Phase 1, 5, 6 (needs data tools, heartbeat, rules).
**Scope:** Significant architectural work (~500 lines).

### 7A. Design decision: Template-based, not 12 folders

Instead of creating 12+ agent folders, create ONE template agent:

**File:** `agents/account-analyst/agent.yaml`
```yaml
id: account-analyst
display_name: Account Analyst
model: claude-sonnet-4-20250514   # Sonnet for per-account analysis (cost control)
icon: ":mag:"
profile: account_analyst
max_turns: 15
channels: []
sub_agents: []
```

**File:** `agents/account-analyst/PERSONA.md`
```markdown
You are an account analyst working under Ada, the senior media buyer.
You analyze one specific ad account with deep focus.
You report findings back to Ada — she makes the final decisions.
You are thorough, data-driven, and follow Ada's methodology exactly.
```

**File:** `agents/account-analyst/INSTRUCTIONS.md`
```markdown
You receive an account code and analysis context from Ada.
Follow the analysis framework in order:
1. Load account profile and rules
2. Run health check (frequency, KPI, spend pacing)
3. If issues found, trace the funnel
4. Check root causes (four forces)
5. Report findings back — DO NOT make kill/scale decisions, only recommend
```

### 7B. New profile: `account_analyst`

**File:** `src/agents/profiles/index.ts`
```typescript
account_analyst: [
  'recall', 'remember', 'search_memories',
  'get_account_profile', 'get_account_rules',
  'get_client_performance', 'get_campaign_performance',
  'get_adset_performance', 'get_ad_performance',
  'get_breakdowns', 'get_account_changes',
  'get_alerts', 'get_learnings',
  'get_creative_details',
]
```

No Slack posting (reports back to Ada), no decision logging (Ada decides).

### 7C. Parallel dispatch

**File:** `src/monitoring/parallel-analysis.ts`

```typescript
// Ada's orchestration loop for daily analysis:
export async function runParallelAccountAnalysis(): Promise<AnalysisReport[]> {
  const clients = await listClients();
  const heartbeats = await runDailyHeartbeat(); // from Phase 5

  // Only deep-analyze accounts that need it
  const needsAnalysis = heartbeats.filter(h => h.health !== 'healthy');

  // Run account analysts in parallel (max 4 concurrent to control API costs)
  const reports = await pMap(needsAnalysis, async (heartbeat) => {
    return askAgent({
      agent_id: 'account-analyst',
      question: `Analyze ${heartbeat.clientCode}`,
      context: JSON.stringify({
        accountCode: heartbeat.clientCode,
        heartbeat,
        analysisDepth: heartbeat.health === 'critical' ? 'deep' : 'standard'
      })
    });
  }, { concurrency: 4 });

  return reports;
}
```

### 7D. Ada compiles and decides

After parallel analysis completes:
1. Ada reviews all account analyst reports
2. Checks for cross-account patterns
3. Makes final kill/scale/pause/iterate decisions
4. Sends morning briefing with analysis + recommendations
5. Logs decisions via `log_decision`

### 7E. Client-facing variant (future)

For when clients get access:
- Create client-specific Slack channels
- Route messages to account-analyst with `clientCode` locked to that channel
- All Supabase queries scoped: `WHERE client_id = $1`
- No cross-account data leaks

### Validation
- Run parallel analysis for 3 accounts
- Verify each gets independent analysis
- Verify Ada aggregates results and identifies cross-account patterns
- Verify cost is reasonable (Sonnet for analysts, Opus only for Ada's synthesis)

---

## Phase 8: Creative Analysis Agent

**Goal:** An agent that can analyze ad creatives — images, videos, transcripts, copy — and answer questions from media buying agents.
**Prerequisites:** Phase 1 (needs `get_creative_details` tool).
**Scope:** Create agent definition + tools (~400 lines).

### 8A. Agent definition

**Folder:** `agents/pixel/`

**`agent.yaml`:**
```yaml
id: pixel
display_name: Pixel
model: claude-opus-4-6
icon: ":film_frames:"
profile: creative_analyst
max_turns: 15
channels: []
sub_agents: []
```

**`PERSONA.md`:**
```markdown
You are Pixel, a creative analyst specializing in performance advertising.
You analyze ad creatives — videos, images, copy — and explain WHY they perform well or poorly.
You understand hooks, storytelling, CTAs, visual hierarchy, and platform-native formats.
You think in terms of: Does it stop the scroll? Does it hold attention? Does it drive action?
```

**`INSTRUCTIONS.md`:**
```markdown
You support the media buying team with creative analysis.

Your capabilities:
1. Analyze video ads — transcribe audio, describe visuals, identify hook/body/CTA structure
2. Analyze image ads — describe composition, copy placement, brand elements
3. Compare creatives — what makes the winner different from the loser?
4. Diagnose creative fatigue — what signals suggest this creative is tired?
5. Suggest creative directions — based on what's working, what to test next

When asked to analyze a creative:
1. Get creative details (metadata, transcript, AI tags) from Supabase
2. If video: analyze hook (first 3 seconds), body (value prop), CTA
3. If image: analyze visual hierarchy, copy, offer clarity
4. Cross-reference with performance data (hook_rate, hold_rate, CTR, conversion_rate)
5. Deliver diagnosis: WHY is this performing well/poorly?

Always connect creative analysis back to performance metrics.
A "beautiful" ad that doesn't convert is a failure. An "ugly" ad with great ROAS is a winner.
```

### 8B. Profile: `creative_analyst`

```typescript
creative_analyst: [
  'recall', 'remember', 'search_memories',
  'get_creative_details',
  'get_ad_performance',
  'get_client_performance',
  'get_learnings',
  'get_concepts',
  'get_briefs',
  'download_creative',    // New tool
  'analyze_image',        // New tool — Claude vision
]
```

### 8C. New tools

**`download_creative`** — Downloads creative media from Supabase Storage or Meta URL
```typescript
{
  name: 'download_creative',
  description: 'Download a creative image or video thumbnail for visual analysis.',
  input_schema: {
    properties: {
      creativeId: { type: 'string' },
      type: { type: 'string', enum: ['thumbnail', 'video_frame'] }
    },
    required: ['creativeId']
  }
}
// Returns: base64 image data or file path
```

**`analyze_image`** — Send image to Claude Vision
```typescript
{
  name: 'analyze_image',
  description: 'Analyze an ad creative image using computer vision. Describes visual elements, copy, composition, and creative strategy.',
  input_schema: {
    properties: {
      imageData: { type: 'string', description: 'Base64 image data or URL' },
      analysisType: { type: 'string', enum: ['full', 'hook', 'copy', 'comparison'] },
      context: { type: 'string', description: 'What to focus on (e.g., "why is this ad underperforming?")' }
    },
    required: ['imageData']
  }
}
// Implementation: Send image as content block to Claude with vision capability
```

### 8D. Integration with Ada

Ada can delegate creative questions to Pixel:
```
"Hey Pixel, analyze the top 3 ads for Ninepine by spend — what creative patterns are winning?"
"Pixel, compare these two ads — the winner has 2x ROAS but similar CTR. What's different?"
"Pixel, our hook rates are declining for Brain.fm. Look at the last 5 creatives and tell me why."
```

Update Ada's agent.yaml:
```yaml
sub_agents: [account-analyst, pixel]
```

### Validation
- Ask Pixel to analyze a specific creative
- Verify it pulls metadata + performance data
- Verify image analysis works via Claude Vision
- Verify Ada can delegate creative questions to Pixel

---

## Phase 9: Tiered Alerting & Insights Dashboard

**Goal:** Not all insights are equal. Build a tiered system that routes alerts appropriately and pushes to BMAD dashboard.
**Prerequisites:** Phase 5 (anomaly detection), Phase 6 (account rules).
**Scope:** Modify alerting pipeline, add Supabase writes (~200 lines).

### 9A. Tier definitions

| Tier | Criteria | Delivery | Response Time |
|------|----------|----------|---------------|
| **P0 — Critical** | 0 conversions + spend >$100, overspend >150%, suspected outage | Immediate DM + #dai channel | ASAP |
| **P1 — Action Needed** | CPA >2x target 2+ days, frequency >3.5, creative fatigue, out of stock signal | Morning briefing highlighted + DM | Same day |
| **P2 — Watch** | Single-day anomaly, trending metrics, rising frequency | Morning briefing listed | Monitor |
| **P3 — FYI** | New learning, hypothesis outcome, honeymoon warning | Weekly reflection only | Informational |

### 9B. Alert pipeline

**File:** `src/monitoring/alert-pipeline.ts`

```typescript
export async function processAlert(alert: AnomalySignal, clientCode: string): Promise<void> {
  // 1. Determine tier
  const tier = classifyTier(alert);

  // 2. Write to BMAD Supabase alerts table
  await writeAlert({
    client_code: clientCode,
    alert_type: alert.signal,
    severity: tierToSeverity(tier), // P0→critical, P1→warning, P2/P3→info
    title: alert.description,
    metric: alert.metric,
    expected_value: alert.expectedValue,
    actual_value: alert.currentValue,
    deviation_percent: alert.deviationPercent,
  });

  // 3. Route based on tier
  switch (tier) {
    case 'P0':
      await sendSlackDM(DANIEL_USER_ID, formatP0Alert(alert, clientCode));
      await postToChannel('#dai', formatP0Alert(alert, clientCode));
      break;
    case 'P1':
      // Included in morning briefing, highlighted
      await queueForBriefing(alert, clientCode, 'highlight');
      break;
    case 'P2':
      await queueForBriefing(alert, clientCode, 'list');
      break;
    case 'P3':
      await queueForWeeklyReflection(alert, clientCode);
      break;
  }
}
```

### 9C. BMAD dashboard integration

Write alerts + insights to BMAD Supabase so they appear in the PMA dashboard. Use existing `alerts` table schema — just ensure Ada's alerts are distinguishable (source = 'ada').

### Validation
- Trigger a P0 alert (simulate 0 conversions) — verify immediate DM
- Trigger a P1 alert — verify it appears in morning briefing
- Verify alerts appear in BMAD dashboard

---

## Phase 10: Deployment to DigitalOcean

**Goal:** DAI runs 24/7 on a server, independent of Daniel's laptop.
**Prerequisites:** All previous phases (deploy the full system).
**Scope:** Create deployment config, set up server (~200 lines config).

### 10A. Dockerfile

**File:** `Dockerfile`
```dockerfile
FROM node:22-alpine

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Copy source
COPY . .

# Build
RUN pnpm build

# SQLite data directory
RUN mkdir -p /app/data
VOLUME /app/data

# Run
CMD ["node", "dist/index.js"]
```

**File:** `docker-compose.yml`
```yaml
version: '3.8'
services:
  dai:
    build: .
    restart: always
    env_file: .env
    volumes:
      - dai-data:/app/data    # Persist SQLite
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  dai-data:
```

### 10B. DigitalOcean setup

```bash
# Create droplet (cheapest with enough RAM for Node + SQLite)
doctl compute droplet create dai-server \
  --region fra1 \
  --size s-1vcpu-2gb \
  --image docker-24-04 \
  --ssh-keys <your-key-id>

# SSH in, clone repo, set up .env, docker compose up -d
```

Estimated cost: ~$12/month for 2GB RAM droplet in Frankfurt.

### 10C. Deployment script

**File:** `scripts/deploy.sh`
```bash
#!/bin/bash
# Simple deployment: build locally, push image, restart on server
# Or: SSH into server, git pull, docker compose up -d --build
```

### 10D. Monitoring

- Docker restart policy handles crashes
- Pino logs captured by Docker logging driver
- Health check: periodic Slack message "Ada is online" or heartbeat ping

### Validation
- Deploy to DO droplet
- Verify Slack Socket Mode connects
- Verify scheduled jobs run (heartbeat, learning loops)
- Verify SQLite data persists across container restarts
- Kill the process — verify it auto-restarts

---

## File Index

### Phase 1: Data Layer
| Action | File |
|--------|------|
| Modify | `src/agents/tools/supabase-tools.ts` |
| Modify | `src/agents/tool-registry.ts` |
| Modify | `src/agents/profiles/index.ts` |

### Phase 2: Metrics Knowledge
| Action | File |
|--------|------|
| Create | `agents/ada/METRICS.md` |
| Modify | `agents/ada/INSTRUCTIONS.md` |

### Phase 3: Methodology Extraction
| Action | File |
|--------|------|
| Create | `scripts/extract-methodology.ts` |
| Output | `data/extraction/*.json` |

### Phase 4: Soul + Methodology
| Action | File |
|--------|------|
| Create | `agents/ada/SOUL.md` |
| Create | `agents/ada/METHODOLOGY.md` |
| Modify | `src/agents/runner.ts` |
| Modify | `src/agents/registry.ts` |

### Phase 5: Proactive Monitoring
| Action | File |
|--------|------|
| Create | `src/monitoring/account-heartbeat.ts` |
| Create | `src/monitoring/morning-briefing.ts` |
| Create | `src/monitoring/anomaly-detector.ts` |
| Modify | `src/scheduler/learning-jobs.ts` |

### Phase 6: Account Rules
| Action | File |
|--------|------|
| Create | BMAD Supabase migration (account_rules, account_profiles tables) |
| Create | `src/agents/tools/account-rules-tools.ts` |
| Modify | `src/agents/tool-registry.ts` |
| Modify | `src/agents/profiles/index.ts` |
| Modify | `agents/ada/INSTRUCTIONS.md` |

### Phase 7: Account Agents
| Action | File |
|--------|------|
| Create | `agents/account-analyst/agent.yaml` |
| Create | `agents/account-analyst/PERSONA.md` |
| Create | `agents/account-analyst/INSTRUCTIONS.md` |
| Create | `src/monitoring/parallel-analysis.ts` |
| Modify | `src/agents/profiles/index.ts` |
| Modify | `agents/_manifest.yaml` |
| Modify | `agents/ada/agent.yaml` |

### Phase 8: Creative Agent
| Action | File |
|--------|------|
| Create | `agents/pixel/agent.yaml` |
| Create | `agents/pixel/PERSONA.md` |
| Create | `agents/pixel/INSTRUCTIONS.md` |
| Create | `src/agents/tools/creative-tools.ts` |
| Modify | `src/agents/profiles/index.ts` |
| Modify | `src/agents/tool-registry.ts` |
| Modify | `agents/_manifest.yaml` |

### Phase 9: Tiered Alerting
| Action | File |
|--------|------|
| Create | `src/monitoring/alert-pipeline.ts` |
| Modify | `src/monitoring/account-heartbeat.ts` |
| Modify | `src/agents/tools/supabase-tools.ts` (write alerts) |

### Phase 10: Deployment
| Action | File |
|--------|------|
| Create | `Dockerfile` |
| Create | `docker-compose.yml` |
| Create | `scripts/deploy.sh` |

---

## Dependencies Between Phases

```
Phase 1 (Data Layer) ──────┬──→ Phase 2 (Metrics) ──→ Phase 5 (Monitoring) ──→ Phase 9 (Alerting)
                           │                                    ↓
Phase 3 (Extraction) ──→ Phase 4 (Soul/Methodology)    Phase 7 (Account Agents)
                           │
                           └──→ Phase 6 (Rules) ──→ Phase 7 (Account Agents)

Phase 1 ──→ Phase 8 (Creative Agent)

Phase 1-9 ──→ Phase 10 (Deployment)
```

**Can run in parallel:**
- Phase 1 + Phase 3 (data layer + transcript extraction are independent)
- Phase 2 + Phase 4 (metrics doc + soul doc, once Phase 1/3 are done)
- Phase 8 can start after Phase 1 (independent of Phases 5-7)

**Must be sequential:**
- Phase 1 → Phase 2 → Phase 5 → Phase 9
- Phase 3 → Phase 4
- Phase 6 → Phase 7
