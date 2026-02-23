# Analysis Workflow — Scenario Playbooks

Step-by-step playbooks for Ada's five core analysis scenarios. Follow the appropriate playbook based on the trigger.

---

## Scenario 1: Routine Account Review

**Trigger:** Scheduled check-in (daily for active accounts, weekly for passive)

### Steps

1. **Load context**
   - Recall account-specific learnings
   - Pull last 7 days performance data
   - Pull campaign-level breakdown
   - Check recent alerts
   - Review accumulated learnings

2. **Quick health check**
   - Frequency: Any campaign above 3.0? Flag if above 3.5
   - TOF engine: Is at least one ad set driving low-frequency fresh reach?
   - Primary KPI trend: Target metric vs 7-day average
   - Spend pacing: On track for the period?
   - Data validity: Numbers look reasonable?

3. **Compare vs previous review**
   - What did we flag last time?
   - Were our predictions correct?
   - Have open hypotheses been confirmed or rejected?

4. **Full funnel diagnosis** (if any metric off by >15%)
   - Walk the funnel in order: spend → frequency → hook rate → hold rate → CTR → PDP view rate → ATC rate → conversion rate → AOV
   - Find the breaking point
   - Apply Four Forces model to identify root cause

5. **Creative status check**
   - Hook rates trending up or down?
   - Any creatives showing fatigue (declining hook rate over time)?
   - Frequency by creative — are we over-serving any single ad?
   - Is the creative pipeline keeping up with kill rate?

6. **Update learnings**
   - Store any new patterns discovered
   - Log decisions with reasoning
   - Note open hypotheses for next session

7. **Set next review**
   - When to check back
   - What specifically to look for
   - Any time-bound actions (check results of a change after 3 days)

---

## Scenario 2: Alert Response (Something Changed)

**Trigger:** Performance anomaly detected — sudden CPA spike, ROAS crash, conversion rate collapse, etc.

### Steps

1. **Load context**
   - Pull current data + previous period comparison
   - Recall account learnings
   - Check alerts for this account

2. **Identify the anomaly precisely**
   - Which metric changed?
   - By how much? (percentage and absolute)
   - Since exactly when? (pinpoint the date)
   - Is it getting worse, stable, or recovering?

3. **Check other accounts FIRST**
   - Are 3+ accounts showing the same pattern today?
   - If YES → platform-wide issue. Report and recommend waiting 24-48 hours. STOP HERE.
   - If NO → account-specific. Continue investigation.

4. **Check for self-inflicted causes**
   - Did we change anything? (budgets, creatives, targeting, bid caps)
   - Did the client change anything? (website, prices, checkout, tracking)
   - Did anyone rename ad sets? (can break reporting tools)
   - Check account activity history for the inflection date

5. **Four Forces investigation**
   - **You**: Budget changes, new creatives, targeting shifts
   - **Destination**: Walk the funnel manually, check landing pages, verify pixel firing
   - **Platform**: Policy changes, algorithm shifts, Health & Wellness flag
   - **Market**: Seasonality, competitor activity, weather, economic conditions

6. **Trace the funnel**
   - Walk each stage to find the breaking point
   - Compare breaking point metric vs historical norm
   - Check if the break is isolated (one campaign) or systemic (all campaigns)

7. **Root cause and action**
   - State the root cause hypothesis with evidence
   - Recommend specific action with timeline
   - If external cause: flag to client with data
   - If ad-level cause: implement fix

8. **Update learnings**
   - Record the anomaly, root cause, and action taken
   - Set follow-up check date

---

## Scenario 3: New Campaign Launch Review

**Trigger:** A new campaign, ad set, or major restructure was launched

### Steps

1. **Load context**
   - Account learnings
   - What was launched and why
   - What the expected performance targets are

2. **Set expectations**
   - This is the **honeymoon phase** — first 14 days before real signal
   - Do NOT make optimization decisions based on early data
   - Only intervene for red flags (see below)

3. **Red flag monitoring only** (Days 1-3)
   - Is tracking working? (pixel firing, events mapping correctly)
   - Is the campaign spending? (if not, check bid caps / audience size)
   - Is there extreme overspend? (runaway budget)
   - Any policy violations or rejections?
   - Is spend going to Audience Network? (check placement breakdown)

4. **Day 3-5: First directional check**
   - Is the funnel working at all? (any conversions?)
   - Are CPMs in expected range for this vertical?
   - Is frequency reasonable? (<1.5 for new campaign)
   - Any obvious creative duds? (hook rate <15%)

5. **Day 7: Interim check**
   - Basic funnel health
   - Frequency trends
   - CPM trends
   - Creative performance ranking (but don't kill yet unless obviously broken)
   - Compare to account's historical first-week performance

6. **Day 14: First real analysis**
   - Full funnel diagnosis
   - Creative diagnosis (hook rate, hold rate, RPC)
   - Kill/scale/iterate decisions NOW appropriate
   - This is the "real" baseline — performance from here is what to optimize against
   - Update account learnings with initial findings

7. **Exception: When to intervene before Day 14**
   - Zero conversions after adequate spend (funnel is broken)
   - Tracking confirmed broken
   - CPA > 10x target with significant spend
   - Policy rejection preventing delivery
   - Budget running away (spending 5x daily budget)

---

## Scenario 4: Cross-Account Health Check

**Trigger:** Weekly portfolio review, or when investigating if an issue is platform-wide

### Steps

1. **Pull performance for ALL accounts** (last 7 days)
   - Primary KPI vs target for each
   - Spend vs budget
   - Week-over-week change

2. **Sort by health status**
   - **Critical**: Primary KPI >30% off target, or zero conversions
   - **Concern**: Primary KPI 15-30% off target
   - **Watch**: Primary KPI 5-15% off target, or frequency trending up
   - **Good**: On target, stable
   - **Excellent**: Beating target, scaling opportunity

3. **Check for platform-wide patterns**
   - Are 3+ accounts showing the same directional change?
   - Did CPMs spike across accounts on the same date?
   - If YES: flag as platform issue, note the date, recommend waiting
   - Check if an Apple update or Meta policy change coincides

4. **Prioritize**
   - Address Critical accounts first
   - Then Concern accounts
   - Then Watch accounts (quick notes only)
   - Good/Excellent accounts: note any scaling opportunities

5. **Quick diagnosis per flagged account**
   - What's the primary issue? (1-2 sentences)
   - Is it account-specific or platform-related?
   - What's the recommended action?
   - When to follow up?

6. **Summary output**
   ```
   ## Portfolio Health — {date}

   ### Platform Notes
   {Any platform-wide observations}

   ### Account Status
   | Account | Health | Primary KPI | vs Target | Key Issue | Action |
   |---------|--------|-------------|-----------|-----------|--------|

   ### Priority Actions
   1. {Most urgent action}
   2. {Second priority}
   3. {Third priority}
   ```

---

## Scenario 5: Creative Refresh Planning

**Trigger:** Account needs new creative — frequency rising, hook rates declining, or client requesting fresh concepts

### Steps

1. **Pull creative performance data**
   - All active creatives with key metrics (spend, hook rate, hold rate, CTR, CPA/ROAS, RPC)
   - Sort by Revenue Per Click (best true-quality signal)
   - Include frequency per creative

2. **Identify fatigued creatives**
   - Declining hook rate over last 2-4 weeks
   - Frequency > 3.5 on the creative level
   - CPA trending up while hook rate drops
   - Once top performers — now average or below

3. **Identify top performers** (what's still working)
   - Rank by Revenue Per Click, NOT just CTR
   - Note: what hooks are these using? (pattern interrupt, curiosity, social proof, etc.)
   - Note: what format? (UGC, studio, static, carousel)
   - Note: what landing page destination?
   - Note: what audience/demographic performs best with this creative?

4. **Map winning patterns**
   - Which hook frameworks work for this account?
   - Which creative formats drive best RPC?
   - Which product angles resonate?
   - Any "chaos in the beginning" style hooks outperforming?
   - Are statics or videos winning?
   - Is showing the product clearly beating lifestyle content?

5. **Generate data-driven creative brief**
   - What to replicate: specific patterns from top performers
   - What to avoid: patterns from underperformers
   - How many new creatives needed (based on current kill rate vs pipeline)
   - Recommended formats and hook types
   - Target: 6 new videos per category per week for TikTok/Meta

6. **Delegate to Creative Strategist**
   - When Maya (Creative Strategist) is available: use `ask_agent("maya", ...)` with the performance data and brief
   - Provide: top performer analysis, what works/doesn't, recommended angles, format preferences
   - Ada provides the data, Maya writes the actual brief

7. **Follow-up plan**
   - When new creatives launch, schedule Day 7 check
   - Compare new creative hook rates vs account average
   - Track whether new creatives reduce account-level frequency

---

## General Rules Across All Scenarios

1. **Always pull real data before analyzing.** No hypothetical analysis.
2. **Always check frequency first.** It's the canary in the coal mine.
3. **Always check for platform-wide patterns** before recommending account-specific changes.
4. **Always update learnings** after every analysis session.
5. **Always provide the "so what"** — not just what happened, but what to do about it.
6. **Compare periods, not absolutes.** Use 7-day vs previous 7-day as default.
7. **Use explicit date ranges**, not "last 7 days" (which means different things on different platforms).
8. **Triage by impact.** Crisis accounts first, biggest levers first.
9. **Time-bound every action.** When to check back, what to look for.
10. **Document everything.** Every analysis builds the account's institutional knowledge.
