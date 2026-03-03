# Piper — Production Coordinator Agent Specification

> This document is the single source of truth for Piper's design and evolution. Each phase is self-contained — a fresh Claude session can read this spec + the referenced files and execute any phase independently.

## Vision

Piper is the **always-on production coordinator**: maintaining the ad production pipeline, tracking delivery cadence per client, assigning editors, surfacing blockers before they cascade into missed deliveries, and ensuring the Notion pipeline is always trustworthy — all without needing a human in the loop for routine operations.

**The design spec in one sentence** (from Mikel, Head of Production):
> "I should be okay to look at the pipeline and not question it."

Piper replaces the human pipeline bookkeeper role and goes beyond it with **always-on Slack monitoring**, automatic Notion status updates, proactive alerts, and real-time reconciliation that a human can't sustain.

**Core architecture:** Piper is event-driven. It continuously watches Slack channels for production signals (footage received, client feedback, revision requests, editor submissions) and automatically updates the Notion pipeline — so the team can finally **trust the data**.

---

## Context: Who Piper Replaces and Why

### The Role Today (Jewel, Production Coordinator)

Based on deep analysis of 23 meeting transcripts (Oct 2025–Mar 2026), the production coordinator:

**Does daily:**
- Opens the Notion ad pipeline with Mikel and walks through every client's ad sets (30-60 min/day)
- Updates statuses in Notion as ad sets progress through pipeline stages
- Creates and maintains task lists within each ad set (manually since automation broke)
- Assigns editors/designers to ready ad sets based on workload
- Sends task assignments to editors via Slack threads
- Follows up with Franzi on approvals, Loreta on footage, Zyra on QC, editors on submissions
- Links raw footage from Google Drive to Notion ad sets
- Adds rehook entries when Daniel/Nina send requests
- Tracks delivery dates and swaps ad sets between weeks when material arrives early/late

**Does weekly:**
- Compiles editor workload overview (manual) and sends to Mikel via DM
- Prepares prioritized action lists for Mikel before meetings
- Participates in Production Squad Kickoff (Monday), Creative Flow Checks (Wednesday), Mid-Week Standups
- Adjusts cadence slots for months with 5 weeks

**Does monthly:**
- Maintains reconciliation notes (planned vs. delivered per client)
- Cross-checks delivery counts with Vanessa's contract records in Monthly Reconciliation meeting

### Why an AI Agent Does This Better

The role is fundamentally **information maintenance** — keeping a database consistent with reality and flagging drift. The current human:

1. **Misses status errors** that Mikel catches during reviews ("When you see that this one is in production and UGC and it doesn't have a task — why do you move past it?")
2. **Can't monitor continuously** — problems are only found during meetings, not in real-time
3. **Has no dashboards** — editor workload is compiled manually, cadence tracking is in people's heads
4. **Can't prevent over/under-delivery** — the Laori 13-ads-on-4-cadence problem was only caught at month-end reconciliation
5. **Is a single point of failure** — if he's busy, the pipeline goes stale
6. **Doesn't contribute strategically** — silent in Account Management Weekly, absent from creative decisions

An AI agent handles the 80% that is data maintenance, status tracking, and report generation while being **always on, always checking, and always alerting**.

### How the Role Evolved (Oct 2025 → Mar 2026)

Analysis of 8 daily standups from Oct–Jan reveals the production coordinator role was actively expanding:

- **Oct 2025:** Jewel's scope was narrow — CRM data entry, timeline tracking, cross-referencing ad set codes. Passive.
- **Nov 12, 2025:** Mikel explicitly upgraded the role: *"Jule is going to be pinging you much more often these days... he's also going to be really tracking a lot of the activities on our CRM and then anything that is set back or needed a follow up or nudge, he's also going to be doing that."*
- **Dec 2025:** Daily standups (which ran Mon/Wed/Fri) were "slowly fizzling out" (Mikel's words). They consistently ran 30-50 min instead of 15 min because Mikel was essentially narrating the tracker to people — a "Mikel solo show" where he did 70-80% of the talking.
- **Jan 2026:** Daily standups replaced by specialized weekly meetings: Production Squad Kickoff (Mon), Creative Flow Check (Wed), Mid-Week Standup, Account Management Weekly.
- **Mar 2026:** Jewel's role fully defined but still struggling with quality control. Mikel: *"Everything is super messy. Like, the task list is just like disaster everywhere."*

**Key people who came and went:**
- **Federico** (creative strategist) — Active Oct–Dec 2025, managed scripts for nearly every client. Was the workhorse before Blessing.
- **Blessing** (creative strategist) — Hired ~Nov 2025, fired Jan 22 2026. Her departure left Franzi as sole creative strategist = major bottleneck.
- **Yra** (Notion engineer) — Joined Feb 2026 to fix Notion automations. Currently rebuilding the task generation system.

### Why the Daily Standup Failed (and What Piper Replaces)

The daily standup format failed because:
1. **It became a tracker read-aloud** — Mikel narrating Notion data that people could see themselves
2. **Not everyone attended** — Nina, Daniel, Jewel, Federico routinely absent
3. **Franzi found it unproductive**: *"I don't understand what you mean but I feel like we're taking a lot of time now and I don't know if this is relevant for everyone."*
4. **Action items didn't stick** — Mikel introduced action item review on Nov 12 but admitted: *"I personally, I'm finding a hard time to build a habit to use them."*
5. **The tracker was unreliable** — every meeting found data quality issues, so the meeting became a debugging session

Piper eliminates the need for pipeline walk-throughs entirely by keeping Notion accurate in real-time and pushing reports/alerts proactively.

---

## The Ad Production Pipeline

### Pipeline Stages (in order)

```
CONCEPT STAGE
├── Create concept / Write creative brief (Franzi)
├── Internal revision / Creative strategy sign-off
├── Send brief to client (Vanessa)
└── Confirm brief / Address client feedback
    │
    ▼
PRE-PRODUCTION (UGC Path)
├── Find UGC creator (Loreta)
├── Send product to creator
├── Creator shooting the ad
├── Deliver UGC raw material
├── QC raw material (Zyra)
└── Organize raw material (link Drive → Notion)
    │
    ▼
PRODUCTION (Editing)
├── Assign editor
├── Edit ad (editor works)
├── First submission
├── QC (Zyra reviews)
├── Revision (editor addresses feedback)
├── CS revision (Franzi/Creative strategist)
├── Additional revision (if needed)
└── Franzi sign-off (only first delivery to new client)
    │
    ▼
LAUNCH STAGE
├── Send to client
├── Client revision (if feedback received)
├── Client approval
├── Upload and configure (Nina, in Meta)
└── Launch / Delivered
```

### Ad Types

| Type | Description | Who Does It |
|------|-------------|------------|
| **UGC Video** | Scripted content filmed by external creators | Loreta coordinates creators, editors cut |
| **Rehook** | New hook on existing winning ad body; counts as 0.5 ad set | Editors (from existing raw footage) |
| **Static** | Still image ad (Figma/Canva) | Glaira (designer) |
| **Motion Graphic** | Animated/motion design ad | Editors |
| **AI-generated** | AI-created video, then polished | Ziggy generates, another editor polishes |
| **Lo-fi / AOT** | Filmed in-house by AOT team | Mikel/Franzi film, editors cut |
| **Founder/Partner Interview** | On-location shoots with client founders | Editors |

### Counting Rules

- **Video** = 1 ad set
- **Static** = 0.5 ad set (2 per ad set)
- **Rehook** = 0.5 ad set (2 per ad set)

### The Team

| Person | Role | Pipeline Touch Points |
|--------|------|----------------------|
| **Mikel** | Head of Production | Makes all production decisions, manages editors, daily pipeline review |
| **Franzi** | Creative Director / CEO | Writes all scripts, final creative sign-off, bottleneck |
| **Vanessa** | Account Manager | Client communication, sends briefs, relays feedback, tracks contracts |
| **Nina** | Media Buyer | Uploads finished ads to Meta, configures targeting |
| **Loreta** | UGC Coordinator | Manages external creators, product shipping, footage delivery |
| **Zyra** | QC Specialist | Reviews all edits, raw material QC, quality gate |
| **Yra** | Production Assistant / Notion Engineer | Notion automations, database architecture |
| **Editors** | Ray, Jack, Ziggy, Cyrus, Amir, Eddie, Fabi, Lucas, Shakar | Video editing, each develops client expertise |
| **Glaira** | Designer | All static ads, end cards, challenge designs |

### Active Clients (as of Mar 2026)

| Client | Monthly Cadence | Special Notes |
|--------|----------------|---------------|
| Audibene | 12 videos + 4 statics | Highest maintenance, extensive revision cycles |
| Ninepine | Ads + rehooks (all AOT, no more external UGC) | Rehooks for localization (Swedish, Norwegian, German, English) |
| Get Going | 8 statics + 12 videos | Huge volume, many creators, slow client approvals |
| Comus | 7 UGC + 2 statics | Contract specifies UGC specifically (not motion graphic) |
| Sweet Spot | 7 UGC + 2 statics | New client, ramping up |
| Strays | ~9/month | Historically in delivery debt, needs monitoring |
| Brain FM | 6 videos (client sends 2 scripts, AOT does 4) | Dream client — easy, no friction |
| Teeth Lover | 4 videos + 4 statics | Double cadence paid |
| Laori | 4/month | DANGER: over-delivered 13 vs 4 in Feb — needs enforcement |
| Press London | 4/month | Creative quality focus |
| Slumber | 4/month | Smooth operations |
| JVA Academy | Regular cadence | Well-managed |
| NoSo | 3 videos + 3 rehooks | Behind on rehooks — needs catch-up |

---

## Capabilities Spec

### Core Capability 0: Always-On Slack Monitoring & Auto-Status Updates

**What:** Piper continuously watches Slack channels for production signals and automatically updates the Notion pipeline — making Notion the reliable single source of truth it was always supposed to be.

**This is the foundational capability.** Everything else builds on top of a Notion database that reflects reality. Today, the Notion pipeline drifts because updates depend on a human remembering to change statuses. Piper watches for real-world signals and updates Notion automatically.

**Slack signal → Notion status update mapping:**

| Slack Signal | Detection Method | Notion Update |
|-------------|-----------------|---------------|
| Loreta says "footage received" / "raw material is in" | Keyword + NLP in production channels | Ad set → "Raw media received"; check off "Deliver UGC raw material" task |
| Loreta says "product shipped to creator" | Keyword + context matching | Ad set → "Send product to creator" status |
| Editor shares first cut / "submitted" | File share + keyword in editor threads | Ad set → "First submission"; check off "Edit ad" task |
| Zyra says "QC done" / "approved" / "revisions needed" | Keyword in QC channel/thread | Ad set → "QC approved" or "Revision"; notify editor |
| Franzi says "signed off" / "approved" / "looks good" | Keyword in approval threads | Ad set → "Franzi sign-off"; check off sign-off task |
| Vanessa says "sent to client" / "client received" | Keyword in client channels | Ad set → "Send to client" status |
| Client feedback / "revision requested" | Keyword in client-facing channels | Ad set → "Client revision"; alert editor + Mikel |
| Nina says "uploaded" / "configured" / "launched" | Keyword in media buying channel | Ad set → "Upload and configure" / "Launched" |
| Daniel/Nina sends rehook requests | Rehook keyword + ad set references | Create new rehook ad set entries |
| Creator confirms shooting | Keyword from Loreta's updates | Ad set → "Creator shooting the ad" |

**How it works technically:**
1. Piper's Slack listener monitors relevant channels (production, client internals, media buying, editor groups)
2. Messages are pre-filtered by keywords (lightweight, no LLM needed for filtering)
3. Matching messages are analyzed by Claude (Haiku for speed) to extract: which ad set, what status change, confidence level
4. High-confidence updates (>0.9) are applied automatically to Notion with a Slack confirmation posted ("Updated Laori #3483 → Raw media received")
5. Medium-confidence updates (0.7-0.9) are proposed to Mikel/Jewel via Slack button for approval
6. Low-confidence signals are logged but not acted on

**Channels to monitor:**
- #production (general production discussion)
- #internal-[client] channels (per-client internal channels)
- #media-buying (Nina's upload updates)
- Editor group chats (submission notifications)
- Loreta DMs/channels (UGC/creator updates)
- QC threads (Zyra's feedback)

**Future expansion — Email monitoring (Phase 9+):**
- Plug into Loreta's inbox to detect creator footage deliveries (Google Drive share notifications, WeTransfer links, email confirmations)
- Plug into Vanessa's inbox to detect client approval emails
- Same pattern: email signal → NLP extraction → Notion update

### Core Capability 1: Pipeline State Management

**What:** Maintain the Notion ad set database as the single source of truth for all production state.

**Specifics:**
- Read and write ad set entries (create, update status, set delivery dates, assign editors)
- Maintain task lists within each ad set (concept → production → launch tasks)
- Detect and alert on status inconsistencies (e.g., "in production" but no editor assigned, "QC" but no submission)
- Ensure every ad set has a complete, correct task list for its format type
- Handle format-specific task templates (video, static, UGC, rehook, AI)

**Pipeline integrity rules an AI enforces that a human misses:**
- Every "in production" ad set MUST have an assigned editor
- Every "in production UGC" ad set MUST have raw material linked
- No ad set should be "upload and configure" unless it was "send to client" first
- Task lists must match the format type (video tasks for videos, static tasks for statics)
- Delivery dates can't be in the past without a status of "delivered" or "launched"

### Core Capability 2: Cadence Tracking & Enforcement

**What:** Real-time tracking of planned vs. delivered ads per client per month.

**Specifics:**
- Maintain cadence config per client (how many of each type per month)
- Auto-generate monthly ad set slots with staggered weekly delivery dates
- Track deliveries in real-time as ad sets reach "delivered" status
- Alert when a client is on track to over-deliver (the Laori problem)
- Alert when a client is under-delivered with enough time to recover
- Handle 5-week months correctly (cadence is monthly, not weekly)
- Produce reconciliation reports on demand (replaces monthly meeting)

**Alert thresholds:**
- Over-delivery: Alert at cadence + 25% (e.g., for 4-cadence client, alert at 5)
- Under-delivery: Alert when (remaining_deliverables / remaining_weeks) > 2x normal rate
- Debt carryover: Track month-over-month surplus/deficit

### Core Capability 3: Editor Workload Management

**What:** Real-time dashboard of editor capacity and automated assignment recommendations.

**Specifics:**
- Track active ad sets per editor (from Notion assignments)
- Maintain editor-client expertise mapping (Amir→Audibene, Luca→Teeth Lover/Strays, etc.)
- Recommend editor for new assignments based on: capacity, client familiarity, format skill
- Alert when workload is imbalanced ("Ray has 8, Jack has 2")
- Track average turnaround time per editor
- Flag editors who haven't submitted for > X days on an assignment

### Core Capability 4: Pipeline Health Monitoring

**What:** Automated scanning for problems, replacing the daily pipeline walk-through.

**Reports generated (proactive, scheduled):**
- **Morning Pipeline Brief** (daily, 8:30am → Mikel via Slack DM):
  - Ads due this week per client + their current status
  - Overdue items (past delivery date, not yet delivered)
  - Blocked items (waiting on raw material, client approval, or Franzi sign-off)
  - Editor workload summary
  - Clients at risk of under/over-delivery this month
- **Creative Flow Summary** (weekly, Wednesday 9am → #production channel):
  - Per client: ads in each pipeline stage, when scripts/footage run out
  - "Running out" warnings (client will exhaust approved scripts in < 2 weeks)
  - Delivery debt status per client
  - Items stuck in "upload and configure" (Nina bottleneck)
- **Monthly Reconciliation Report** (1st of month → Mikel + Vanessa):
  - Per client: cadence target vs. actual delivered
  - Surplus/deficit carryover into next month
  - Over-delivery flagged with cost implications

### Core Capability 5: Follow-Up Automation

**What:** Timed reminders based on pipeline state and delivery dates.

**Follow-up triggers:**
- Brief sent to client → no response in 3 days → remind Vanessa
- Product shipped to creator → no raw footage in 7 days → alert Loreta
- Editor assigned → no first submission in 3 days → ping editor + Mikel
- QC revision sent back → no resubmission in 2 days → ping editor
- Franzi sign-off requested → no sign-off in 2 days → remind Franzi
- "Send to client" status → no client approval in 5 days → remind Vanessa
- "Upload and configure" status → not launched in 3 days → flag Nina

### Core Capability 6: Bidirectional Slack ↔ Notion Sync

**What:** Not just Slack → Notion (Core Capability 0), but also Notion → Slack. When pipeline state changes in Notion, the right people get notified in Slack with everything they need.

**Why this matters:** Yra flagged that *"some of the editors don't even touch the Notion system and just highly depend on Slack."* Piper bridges this gap — editors never need to open Notion, but Notion stays accurate because Piper handles both directions.

**Notion → Slack push notifications:**

| Notion Event | Slack Action |
|-------------|-------------|
| Editor assigned to ad set | DM editor with: brief link, raw material Drive folder, deadline, client context, format type |
| QC revision created | DM editor with: revision notes from Zyra, link to ad set, deadline |
| Raw footage linked to ad set | Notify Zyra in QC channel: "Raw material ready for QC — [Client] #[ID]" |
| Ad set reaches "QC approved" | Notify Mikel: "Ready for editor assignment — [Client] #[ID]" |
| Ad set reaches "Franzi sign-off" | Notify Vanessa: "Ready to send to client — [Client] #[ID]" |
| Ad set reaches "Client approved" | Notify Nina in #media-buying: "Ready for upload — [Client] #[ID]" with Drive link |
| Ad set reaches "Send to client" | Notify in client internal channel: "New ad ready for review — [Client] #[ID]" (solves Audibene's *"they don't know when they received something in Notion"* problem) |
| Cadence at risk (over/under) | Alert Mikel + Vanessa with current count vs. target |

**Editor workflow (zero Notion required):**
1. Piper DMs editor: "You've been assigned Laori #3483 (UGC video). Brief: [link]. Raw footage: [Drive link]. Deadline: March 9."
2. Editor works in their tools, posts "submitted" in the editor group chat
3. Piper detects → updates Notion → notifies Zyra for QC
4. Zyra posts revision notes → Piper DMs editor with revision instructions
5. Editor resubmits → Piper updates Notion → cycle continues

### Core Capability 7: Pipeline Depth Prediction

**What:** Per-client calculation of how many weeks of approved content remain at each pipeline stage. Automatic "running out" alerts.

**Why this matters:** In every Creative Flow Check, Mikel manually calculates when each client will exhaust approved scripts and footage. This is the core question that drives the entire meeting. From the Jan 22 New Workflow meeting, Mikel directed: *"Drew, let's really make an overview on when each client is running out of scripts and until when."*

**The metric: Weeks Until Empty (WUE)**

For each client, Piper calculates:
```
WUE = (approved_scripts_in_pipeline + ads_in_production) / weekly_cadence_rate
```

**Alerts:**
- **WUE < 2 weeks** → Urgent alert to Franzi + Mikel: "Ninepine will run out of approved scripts by March 16 — 3 scripts needed"
- **WUE < 3 weeks (UGC)** → Alert to Loreta: "Comus has 2 UGC scripts approved but no creator assigned — footage needed by March 9" (UGC needs more lead time)
- **WUE = 0** → Critical: "Press London has no footage or scripts after March 2 — production will stall"

**Weekly "Pipeline Depth" report** (replaces most of the Creative Flow Check meeting):

```
Pipeline Depth Report — Week of March 3
────────────────────────────────────────
Client          WUE   Scripts  In Prod  Footage  Status
Audibene        4.2w  8        5        3 pending ✅ Healthy
Ninepine        1.5w  2        3        1 pending ⚠️ Scripts needed
Get Going       3.0w  12       4        6 ready   ✅ Healthy
Comus           2.1w  3        2        0 pending ⚠️ Footage needed
Laori           0.5w  1        1        0 none    🔴 CRITICAL
Press London    0.0w  0        0        0 none    🔴 STALLED
...
```

### Core Capability 8: Franzi Queue Management

**What:** Automated priority management for Franzi, the single biggest pipeline bottleneck.

**Why this matters:** After Blessing was fired (Jan 22), Franzi is the sole creative strategist for 13+ clients. She said: *"I'm the only creative strategist right now... I'm a big blocker, which is uncomfortable for everyone."* Mikel committed to sending her a bi-daily task list but never built the habit. Piper automates this.

**Daily priority DM to Franzi (9am and 2pm):**
```
Good morning Franzi — here's your priority queue:

🔴 URGENT (clients will miss Monday delivery):
1. Ninepine — 3 scripts needed by March 7 (WUE: 1.5w)
2. Laori — 2 scripts needed by March 5 (WUE: 0.5w)

⚠️ THIS WEEK:
3. Comus — 2 UGC scripts (creators ready, waiting on scripts)
4. Strays — 1 script (editor available, no brief)

✅ CAN WAIT:
5. Brain FM — 4 scripts (WUE: 3.0w, Jack sending 2)
6. Slumber — 2 scripts (WUE: 2.8w)

📊 Your queue: 14 items | Throughput this week: 6 scripts
```

**What Piper tracks:**
- Franzi's queue size (items waiting on her sign-off or script writing)
- Her throughput (scripts written per day, average turnaround)
- When her queue grows beyond capacity: "Franzi has 14 items waiting — 3 clients will miss Monday delivery"
- Auto-advance pipeline when she signs off (detected via Slack monitoring)

**Scope boundary:** Piper doesn't tell Franzi WHAT to write. It tells her what to prioritize based on delivery math and pipeline depth.

### Core Capability 9: Cross-Agent Intelligence with Ada

**What:** Connect production pipeline data with ad performance data from Ada for performance-informed production decisions.

**Why this matters:** No human coordinator could correlate pipeline state with real-time ad performance. Ada knows which ads perform; Piper knows what's in production. Together they unlock new workflows.

**Cross-agent workflows:**
- **Ada identifies winning ad → auto-suggest rehook**: Ada flags "Laori #3200 has 2.1x ROAS, best performer this month" → Piper proposes to Mikel: "Create rehook for Laori #3200? [Approve]" → Piper creates the ad set entry with original footage linked
- **Performance-informed cadence**: Ada sees all of a client's ads underperforming → Piper flags to Franzi: "Teeth Lover — all 4 Feb ads below benchmark. Consider creative pivot before producing more of the same."
- **Format effectiveness**: Monthly insight: "Laori UGC outperforms lo-fi by 3.2x — consider shifting cadence mix toward UGC"
- **Dead ad detection**: Ada sees an ad in "Launched" status with zero spend after 3 days → Piper flags to Nina: "Ninepine #3490 launched but not spending — check targeting"

---

## Tool Requirements

### Notion Tools (Primary — the pipeline lives here)

| Tool | Description | Priority |
|------|-------------|----------|
| `query_pipeline` | Query ad set database with filters (client, status, date range, editor, format) | P0 |
| `update_ad_set` | Update ad set properties (status, editor, delivery date, format) | P0 |
| `create_ad_set` | Create new ad set entry with full task list for format | P0 |
| `get_task_list` | Get task list within an ad set | P0 |
| `update_task` | Check/uncheck tasks, update task status | P0 |
| `query_cadence_config` | Get client cadence configurations | P0 |
| `get_pipeline_views` | Access filtered views (per client, per editor, creative strategist view) | P1 |

### Slack Tools

| Tool | Description | Priority |
|------|-------------|----------|
| `post_message` | Send messages to channels and DMs | P0 |
| `reply_in_thread` | Reply in existing threads | P0 |
| `send_pipeline_brief` | Send formatted pipeline health reports | P0 |
| `read_channel_messages` | Read recent messages from production channels | P0 |
| `monitor_channels` | Continuous listener on production/client/editor channels for status signals | P0 |
| `search_channel_history` | Search Slack history for context when processing an ambiguous signal | P1 |

### Gmail Tools (for inbox monitoring — Phase 9+)

| Tool | Description | Priority |
|------|-------------|----------|
| `monitor_inbox` | Watch Loreta's/Vanessa's inbox for creator deliveries and client approvals | P2 |
| `search_emails` | Search email threads for delivery confirmation context | P2 |

### Memory Tools

| Tool | Description | Priority |
|------|-------------|----------|
| `recall` | Retrieve past observations and context | P0 |
| `remember` | Store observations and patterns | P0 |
| `search_memories` | Search memory by keyword | P0 |

### Google Drive Tools (for footage tracking)

| Tool | Description | Priority |
|------|-------------|----------|
| `check_drive_folder` | Verify if raw footage exists in expected Drive location | P1 |
| `link_footage` | Create/verify Drive shortcuts linked to Notion ad sets | P2 |

### Delegation Tools

| Tool | Description | Priority |
|------|-------------|----------|
| `ask_agent` | Delegate to Otto for cross-agent coordination | P1 |
| `ask_ada` | Request ad performance data from Ada (winning ads, format effectiveness) | P1 |

### Reporting Tools

| Tool | Description | Priority |
|------|-------------|----------|
| `generate_pipeline_report` | Generate formatted pipeline health reports | P0 |
| `generate_reconciliation` | Generate monthly cadence reconciliation | P0 |
| `generate_workload_report` | Generate editor workload dashboard | P0 |
| `generate_pipeline_depth` | Calculate per-client Weeks Until Empty (WUE) metric | P0 |
| `generate_franzi_queue` | Generate Franzi's priority queue sorted by urgency | P0 |

### Fireflies Tools (for meeting intelligence — Phase 12)

| Tool | Description | Priority |
|------|-------------|----------|
| `get_meeting_transcript` | Fetch full transcript from Fireflies after production meetings | P2 |
| `extract_pipeline_actions` | Parse transcript for status changes, assignments, date changes | P2 |

---

## Knowledge Piper Needs

### INSTRUCTIONS.md — Operational Rules

```markdown
You are Piper, the production coordinator for Ads on Tap, a performance marketing agency.

## Your Core Job
Ensure the ad production pipeline in Notion is always accurate, always current, and always surfacing problems before they cascade into missed deliveries.

## Pipeline Rules
- Every ad set in "in production" MUST have an assigned editor
- Every UGC ad set MUST have raw material linked before entering production
- Status progression is strictly linear: concept → production → launch
- No ad set should skip stages (e.g., concept → upload and configure is an error)
- Task lists must match format type (video tasks for videos, static tasks for statics)
- Rehooks and statics count as 0.5 ad sets for cadence
- Monthly cadence is the hard constraint — flag any client exceeding cadence + 25%

## Delivery Rules
- Target delivery day is Monday each week
- Months with 5 weeks: cadence stays monthly (don't add extra ads)
- When over-delivering: alert Mikel + Vanessa, suggest reducing next month's slots
- When under-delivering: alert when recovery requires > 2x normal weekly rate

## Who You Report To
- Mikel (Head of Production) — your primary stakeholder. Pipeline briefs go to him.
- Vanessa (Account Manager) — delivery commitments, client feedback, reconciliation
- You don't make creative decisions. You don't decide which editor gets which client.
- You surface information, flag problems, and execute pipeline updates.

## Communication Style
- Be concise and data-driven
- Lead with the problem, then the data, then a suggested action
- Use client names consistently (not nicknames)
- Format Slack messages with clear sections and bullet points
- Never surprise Mikel — if something is off, flag it immediately
```

### PERSONA.md — Identity

```markdown
You are Piper, the production coordinator at Ads on Tap.

You are the nervous system of the ad production pipeline — always sensing, always checking, always ensuring nothing falls through the cracks. You don't create ads, you don't manage clients, you don't make creative decisions. You make sure the RIGHT thing happens at the RIGHT time by the RIGHT person.

Your superpower is that you never sleep, never forget, and never "move past" something that looks wrong. If an ad set has no task list, you flag it. If an editor hasn't submitted in 3 days, you follow up. If a client is getting 13 ads on a 4-ad contract, you catch it on ad #5, not ad #13.

You speak with the team directly via Slack. You are professional, helpful, and proactive — but you never overstep. You inform and recommend; Mikel decides.
```

### TEAM.md — Team Context

Full team directory with roles, communication preferences, and typical response times — similar to Jasmin's TEAM.md.

### PIPELINE.md — Pipeline Reference

Detailed reference document with:
- All pipeline stages and their meaning
- Task templates per format type
- Counting rules (video=1, static=0.5, rehook=0.5)
- Client cadence configurations
- Editor-client expertise mapping
- Common status errors and how to detect them

---

## Phased Implementation

### Phase 1: Agent Definition + Notion Pipeline Read + Dedicated Bot

**Goal:** Piper exists as a dedicated Slack bot, can query the Notion pipeline, and answer questions about production state.
**Scope:** Agent YAML, persona, instructions, Notion read tools, own Slack app.

**Deliverables:**
- `agents/piper/agent.yaml` — id, display_name, model (claude-opus-4-6), profile (production_coordinator)
- `agents/piper/PERSONA.md` — identity and communication style
- `agents/piper/INSTRUCTIONS.md` — operational rules, pipeline rules, team context
- `agents/piper/PIPELINE.md` — pipeline stage reference, task templates, counting rules
- `agents/piper/TEAM.md` — team directory, communication preferences, response times
- New profile `production_coordinator` in `src/agents/profiles/index.ts`
- **Dedicated Slack app** (own bot token + app token, same pattern as Jasmin): `PIPER_BOT_TOKEN` + `PIPER_APP_TOKEN`
  - Team members DM Piper directly for pipeline queries
  - Mikel: "What's the status on Audibene this week?"
  - Loreta: "Footage for Comus #3500 arrived" (explicit high-confidence signal)
  - Vanessa: "How many ads have we delivered to Ninepine this month?"
- Notion read tools: `query_pipeline`, `get_task_list`, `query_cadence_config`
- Memory tools: recall, remember, search_memories
- Slack tools: post_message, reply_in_thread
- Register in manifest, router keywords

**Test:** DM Piper "What's the pipeline status for Audibene this week?" → queries Notion → gives accurate answer.

### Phase 2: Always-On Slack Monitoring — Slack → Notion (THE KEY PHASE)

**Goal:** Piper watches Slack channels 24/7 and automatically updates Notion statuses based on real-world signals. This is what makes Notion trustworthy.
**Prerequisites:** Phase 1.

**Deliverables:**
- Slack channel listener (event-driven, not polling) monitoring production/client/editor channels
- Signal detection layer:
  - Keyword pre-filter (lightweight regex, no LLM): "footage received", "submitted", "approved", "revision", "uploaded", "launched", "sent to client", "raw material", "product shipped"
  - Context extraction via Haiku: identify which ad set / client / person the signal refers to
  - Confidence scoring: high (>0.9) = auto-update, medium (0.7-0.9) = propose to Mikel, low = log only
- Notion auto-updater: applies status changes + checks off relevant tasks
- Confirmation messages: posts in thread "Updated [Client] #[ID] → [New Status]" after every auto-update
- Supabase logging: `pipeline_events` table tracking every signal detected + action taken
- Dashboard: "Piper Activity Log" — what signals were detected, what was updated, what was ignored
- Configurable channel list (add/remove channels Piper monitors)

**Signal → Status mapping (initial set):**

| Signal Pattern | Source | Notion Update |
|---------------|--------|---------------|
| "footage received" / "raw material in" / "just received footage" | Loreta in production/client channels | → Raw media received |
| "product shipped" / "sent the product" | Loreta updates | → Send product to creator |
| "submitted" / "first cut ready" / editor shares video file | Editor group chats | → First submission |
| "QC done" / "approved" / "needs revisions" | Zyra in QC threads | → QC approved / Revision |
| "signed off" / "looks good" / "approved" | Franzi in review threads | → Franzi sign-off |
| "sent to client" / "client has it" | Vanessa in client channels | → Send to client |
| "client wants changes" / "revision request" / "feedback:" | Vanessa relaying client input | → Client revision; alert editor |
| "uploaded" / "configured" / "live" | Nina in media buying channel | → Upload and configure / Launched |
| "assigned to [editor]" / "giving this to [editor]" | Mikel in production channel | → Update editor assignment |
| Rehook request with ad set references | Daniel/Nina in production | Create new rehook ad set entries |

**Trust-building approach:** First 2 weeks = "shadow mode" — Piper detects signals and proposes updates in a dedicated #piper-activity channel, but doesn't write to Notion. Team reviews proposals. After validation, enable auto-updates for high-confidence signals.

**Test:** Loreta posts "Just received the footage for Comus #3500" in #internal-comus → Piper detects → updates Notion → posts confirmation.

### Phase 3: Bidirectional Sync — Notion → Slack

**Goal:** When pipeline state changes in Notion, the right people get notified in Slack with everything they need. Editors never need to open Notion.
**Prerequisites:** Phase 1 + Phase 2.

**Deliverables:**
- Notion webhook / polling listener for status changes
- Push notifications on pipeline events (see Core Capability 6 for full mapping):
  - Editor assigned → DM editor with brief, raw material link, deadline, client context
  - QC revision → DM editor with revision notes and deadline
  - Raw footage linked → Notify Zyra for QC
  - Franzi sign-off complete → Notify Vanessa to send to client
  - Client approved → Notify Nina to upload (in #media-buying)
  - Ad sent to client → Notify in client internal channel (solves Audibene notification problem)
- Rich Slack messages with Block Kit: brief preview, Drive links, action buttons
- "Acknowledge" button: editor clicks to confirm they've seen the assignment

**Test:** Mikel assigns Ray to Laori #3483 in Notion → Piper DMs Ray with full context → Ray clicks "Acknowledge" → Piper marks task as acknowledged.

### Phase 4: Pipeline Depth Prediction + Franzi Queue

**Goal:** Per-client "weeks until empty" calculation + automated priority queue for Franzi. Replaces most of the Creative Flow Check meeting.
**Prerequisites:** Phase 1.

**Deliverables:**
- Pipeline depth calculator: per client, count approved scripts + ads in production, divide by weekly cadence rate
- WUE (Weeks Until Empty) metric per client, updated in real-time
- Weekly Pipeline Depth Report (Wednesday 9am → #production channel)
- Automatic alerts:
  - WUE < 2 weeks → Urgent alert to Franzi + Mikel
  - WUE < 3 weeks (UGC) → Alert to Loreta (longer lead time needed)
  - WUE = 0 → Critical alert: "Production will stall"
- Franzi priority DM (daily 9am + 2pm):
  - Sorted by urgency (lowest WUE first)
  - Shows client, scripts needed, delivery deadline
  - Tracks her throughput (scripts written per day)
  - Alerts when queue exceeds capacity

**Test:** Laori has 1 script in pipeline, 1 ad in production, cadence = 1/week → WUE = 2.0 → included in Franzi's priority list. When WUE drops to 1.5 → urgent alert fires.

### Phase 5: Cadence Tracking & Reconciliation

**Goal:** Real-time delivery tracking replaces monthly reconciliation meetings.
**Prerequisites:** Phase 1.

**Deliverables:**
- Cadence configuration storage (Supabase table: `client_cadence`)
- Real-time delivered count per client per month (from Notion "delivered" status)
- Auto-generate monthly ad set slots based on cadence config
- Over/under-delivery alerts (see Core Capability 2 for thresholds)
- Monthly reconciliation report generation (1st of month → Mikel + Vanessa)
- On-demand dashboard: DM Piper "reconciliation for February" → instant report

### Phase 6: Pipeline Write Operations (On-Demand)

**Goal:** Piper can update the pipeline on request (beyond auto-status-updates from Phase 2).
**Prerequisites:** Phase 1 + Phase 2.

**Deliverables:**
- `update_ad_set` — change status, editor, delivery date (via Slack DM to Piper)
- `create_ad_set` — create new entry with correct task list for format
- `update_task` — check/uncheck tasks within ad sets
- Confirmation workflow for bulk/destructive actions: Piper proposes → Mikel approves via Slack button → Piper executes
- Bulk operations: "Create March slots for all clients" with one approval
- Natural language pipeline updates: Mikel DMs Piper "move Laori #3483 to next week, assign to Ray" → Piper executes

### Phase 7: Follow-Up Automation

**Goal:** Piper automatically follows up at pipeline handoff points.
**Prerequisites:** Phase 2 + Phase 6.

**Deliverables:**
- Follow-up timer system (Supabase table: `pipeline_followups`)
- Timers start automatically when Phase 2 detects a status change
- Configurable follow-up rules per pipeline stage (see Core Capability 5 for thresholds)
- Slack reminders to the right person at the right time
- Escalation: if first reminder is ignored after 24h, escalate to Mikel
- "Snooze" support: team members can react with :clock: to snooze a reminder

### Phase 8: Editor Workload Intelligence

**Goal:** Real-time editor capacity tracking and assignment recommendations.
**Prerequisites:** Phase 1.

**Deliverables:**
- Editor workload dashboard (query Notion for active assignments per editor)
- Editor-client expertise mapping (stored in agent knowledge, updated from Phase 2 observations)
- Assignment recommendations: when Mikel asks "who should edit this?", Piper recommends based on capacity + expertise
- Weekly editor utilization report
- Imbalance alerts ("Ray has 8 active, Jack has 2")

### Phase 9: Cross-Agent Pipeline with Ada

**Goal:** Connect production pipeline with ad performance data for performance-informed production decisions.
**Prerequisites:** Phase 6 + Ada Phase 1.

**Deliverables:**
- Ada → Piper: winning ad identified → auto-propose rehook creation
- Ada → Piper: all ads underperforming → flag creative pivot needed before producing more
- Monthly format effectiveness report: "UGC outperforms lo-fi by 3.2x for Laori"
- Dead ad detection: launched but no spend after 3 days → flag to Nina
- Piper exposes pipeline data to Ada via inter-agent API (what's in production, what's launching this week)

### Phase 10: Learning & Self-Improvement

**Goal:** Piper learns from corrections and improves over time.
**Prerequisites:** Phase 2+.

**Deliverables:**
- When Mikel corrects a pipeline status that Piper set, learn the pattern (adjust signal detection)
- When Piper proposes an update and it's rejected, learn why
- Reaction-based feedback on reports (thumbs up/down on pipeline briefs)
- Weekly reflection: "What did I miss this week? What can I check for next time?"
- Integration with DAI's existing learning system (feedback → learnings → context injection)
- Signal detection refinement: track false positive rate per signal type, adjust confidence thresholds

### Phase 11: Email Monitoring (Loreta + Vanessa Inboxes)

**Goal:** Extend always-on monitoring to email for creator deliveries and client approvals.
**Prerequisites:** Phase 2 (proven signal detection pattern).

**Deliverables:**
- Gmail integration for Loreta's inbox:
  - Detect Google Drive share notifications (creator sharing footage)
  - Detect WeTransfer / Dropbox delivery links
  - Detect creator confirmation emails ("footage sent", "uploaded the files")
  - → Auto-update Notion: ad set → "Raw media received"
- Gmail integration for Vanessa's inbox:
  - Detect client approval emails ("looks good", "approved", "go ahead")
  - Detect client revision requests ("can you change...", "feedback:")
  - → Auto-update Notion: ad set → "Client approved" or "Client revision"
- Same confidence scoring as Phase 2 (high = auto, medium = propose, low = log)

### Phase 12: Meeting Intelligence

**Goal:** Piper processes meeting transcripts and extracts pipeline actions.
**Prerequisites:** Phase 6.

**Deliverables:**
- After each Fireflies meeting, Piper reads the transcript and extracts:
  - Status changes discussed ("we sent Audibene #3500 to client")
  - Date changes ("move Laori to next week")
  - Editor assignments ("give this to Ray")
  - New ad set requests ("create a rehook for Ninepine")
- Proposes all extracted actions to Mikel in a single Slack message with approve/reject buttons
- Post-meeting summary: "Pipeline changes from today's standup" — what changed, what's pending

---

### Phase Dependencies

```
Phase 1 (Foundation + Bot)
├── Phase 2 (Slack → Notion monitoring)
│   ├── Phase 3 (Notion → Slack sync)
│   ├── Phase 7 (Follow-up automation)
│   └── Phase 10 (Learning)
├── Phase 4 (Pipeline depth + Franzi queue)
├── Phase 5 (Cadence tracking)
├── Phase 6 (Write operations)
│   ├── Phase 9 (Cross-agent with Ada)
│   └── Phase 12 (Meeting intelligence)
├── Phase 8 (Editor workload)
└── Phase 11 (Email monitoring, after Phase 2)
```

---

## Dependencies and Risks

### External Dependencies
- **Notion API access**: Need read/write access to the ad pipeline database. This is the critical path.
- **Notion database schema**: Need to understand the exact database structure (properties, relations, views). Yra is the expert.
- **Cadence data**: Currently lives in people's heads and Vanessa's notes. Needs to be formalized in a database.
- **Slack channel access**: Piper needs to be added to all production, client-internal, editor, and media buying channels.
- **Gmail OAuth (Phase 9)**: Need Loreta's and Vanessa's consent for inbox read access.

### Risks
- **Notion API rate limits**: Pipeline scanning every 2h across 13+ clients could hit limits. Mitigate with smart caching and incremental polling.
- **Pipeline schema changes**: Yra is actively restructuring Notion. Piper needs to be resilient to schema evolution.
- **Trust building**: Team needs to trust Piper's auto-updates before relying on them. Phase 2 starts in "shadow mode" — propose only, don't write. Earn trust, then enable.
- **False positives in signal detection**: Someone saying "looks good" about a coffee order shouldn't update a pipeline status. Context extraction must be robust. Mitigate with confidence scoring + shadow mode validation.
- **Signal disambiguation**: When Loreta says "footage received" in a channel with multiple clients, Piper needs to figure out WHICH ad set. May need to ask clarifying questions in-thread.
- **Scope creep**: Piper is NOT a creative strategist, NOT an account manager, NOT a project manager. Keep scope tight.
- **Editor adoption**: Some editors don't use Notion at all (they "highly depend on Slack" — Yra, Feb 6). Piper bridges this gap by watching Slack, but editors may also need to learn to tag Piper.

### Integration Points with Existing DAI Agents
- **Jasmin**: Piper's pipeline alerts feed into Jasmin's morning briefing for Daniel. Jasmin can ask Piper for pipeline status on demand.
- **Ada**: Ada's media buying insights (winning/losing ads) inform which ads to rehook. Ada can request Piper to create rehook ad sets.
- **Otto**: Piper delegates non-production questions to Otto (same pattern as Jasmin).
- **Shared infrastructure**: Piper uses the same Slack listener framework as Jasmin (dedicated bot or shared DAI bot), same Supabase for persistence, same learning system.

---

## Glossary

| Term | Meaning |
|------|---------|
| Ad set | A single ad creative unit in the pipeline, identified by numeric ID |
| Cadence | Contractually agreed number of ads per month per client |
| Rehook | Re-editing the opening hook of an existing ad with new footage/script |
| UGC | User-Generated Content — footage filmed by external creators |
| Lo-fi | Intentionally low-production, casual/authentic style |
| B-roll | Supplementary footage (product shots, lifestyle clips) |
| End card | Final frame/screen of a video ad |
| QC | Quality Control review by Zyra |
| CS revision | Creative Strategy revision by Franzi |
| Pipeline health | Whether the Notion database accurately reflects production reality |
| Over-delivery | Producing more ads than the monthly contract requires (costs money) |
| Debt | Cumulative under-delivery carried forward from previous months |

---

## Research Sources

This spec was built from deep transcript analysis of 23 Fireflies meeting recordings (Oct 2025–Mar 2026):

**Production-core meetings (5):**
- Pipeline Health Check (Mar 3) — 54 min, Jewel + Mikel
- Production Squad Kickoff (Feb 16) — 41 min, Jewel + Loreta + Mikel + Zyra + Yra
- Ad-hoc Jewel+Mikel (Mar 3) — 17 min
- Task Automations (Feb 25) — 17 min, Yra + Jewel + Mikel
- Production Daily Standup (Jan 2) — 29 min

**Creative workflow meetings (5):**
- Creative Flow Check (Feb 12) — 35 min
- Creative Flow Check (Feb 6) — 25 min
- Creative Flow Check (Jan 28) — 29 min
- Creative Flow Check (Jan 22) — 33 min
- New Creative Workflow (Jan 22) — 20 min

**Cross-functional meetings (5):**
- Account Management Weekly (Feb 25) — 60 min
- Account Management Weekly (Feb 11) — 52 min
- Mid-Week Standup (Feb 25) — 33 min
- Mid-Week Standup (Feb 11) — 30 min
- Monthly Reconciliation (Feb 26) — 25 min

**Daily standups — recent period (4):**
- Production Daily Standup (Jan 2) — 29 min
- Production Daily Standup (Dec 19) — 28 min
- Production Daily Standup (Dec 10) — 47 min
- Production Daily Standup (Dec 3) — 45 min

**Daily standups — early period (4):**
- Production Daily Standup (Nov 12) — 37 min
- Production Daily Standup (Nov 5) — 29 min
- Production Daily Standup (Oct 31) — 32 min
- Production Daily Standup (Oct 22) — 26 min

**Key insights from daily standups:**
- The standup format evolved from client-by-client walkthrough (Oct) → person-by-person with action items (Nov) → specialized weekly meetings (Jan+)
- Jewel's role was explicitly upgraded from passive CRM entry to active follow-up on Nov 12
- Federico (creative strategist) was the pre-Blessing workhorse managing scripts for nearly every client
- Nina consistently absent from standups and not updating upload statuses — a pain point that persists
- The tracker (Notion) was being actively built during Oct-Nov; Daniel was improving database views
- Meeting format failed because it became "Mikel narrating the tracker" — the tracker should speak for itself
- Action item tracking was introduced Nov 12 but never became habitual
