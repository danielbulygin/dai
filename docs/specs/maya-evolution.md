# Maya Evolution — Master Specification

> This document is the single source of truth for Maya's evolution. Each phase is self-contained — a fresh Claude session can read this spec + the referenced files and execute any phase independently.

## Vision

Maya is the **world's best creative strategist AI agent**. She lives at the intersection of creative craft, performance data, and visual intelligence. She doesn't just write briefs — she researches, strategizes, iterates, sees, and learns. She turns raw performance data + market research + visual analysis into diverse, insight-driven ad concepts that win.

Maya replaces the need for a human creative strategist to do execution work (research, concepts, briefs, QC), freeing humans (Franzi) to focus on high-level strategy, client relationships, and team leadership.

### What Makes Maya "World's Best"
1. **Closed learning loop** — briefs track to ads via ad ID, performance feeds back, Maya gets better over time
2. **Visual intelligence** — sees and analyzes ads (Pixel merged into Maya), generates visual references
3. **Multi-source research** — TikTok, Ad Library, competitor ads, reviews (own + third-party + competitor)
4. **Creative diversity scoring** — automatically tracks format/angle/style distribution, flags gaps
5. **Format × Angle framework** — structured creative coordinate system, not random ideation
6. **Client feedback pipeline** — monitors Slack + call transcripts, auto-revises briefs with approval workflow
7. **Cross-account intelligence** — patterns across all clients, agency-level advantage
8. **Proactive monitoring** — alerts when creative pipeline is low, fatigue detected, diversity gaps emerge

### Who Interacts with Maya
- **Franzi** (primary) — Head of Creative Strategy, approves concepts/briefs, provides feedback
- **Team members** — editors, designers, creators receive briefs
- **Clients** — receive testing roadmaps, monthly reports (via Franzi's approval)
- **Ada** — provides performance data, account analysis, methodology knowledge
- **Daniel** — system admin, architecture decisions

---

## Architecture

### Agent Design: Orchestrator with Smart Tools

Maya is a **single DAI agent** (not sub-agents) with access to specialized tools. Heavy analysis happens inside tools (some internally use Claude/Gemini calls with focused prompts). Maya's own context stays lean and focused.

**Why not sub-agents:**
- No coordination overhead — one conversation, one context
- Tools handle data isolation (scoped by client, product line)
- Format/angle knowledge is GLOBAL (should cross-pollinate across clients — agency advantage)
- Client context is SCOPED (dynamically loaded per request)
- Heavy analysis in tools keeps Maya's context clean

### Context Layering

```
Layer 0 — Always loaded (~8K tokens):
  ├── PERSONA.md (personality, role, constraints)
  ├── CREATIVE-METHODOLOGY.md (how Maya thinks about strategy)
  └── FORMAT-REGISTRY.md (compact overview of all formats + angles)

Layer 1 — Per-client (loaded when working on a client):
  └── clients/{code}.md (brand, products, voice, dos/don'ts, past learnings)

Layer 2 — Per-task (from tool results, on demand):
  ├── Performance data (via ask_ada or direct BMAD queries)
  ├── Research results (TikTok, competitors, reviews)
  ├── Inspiration references (swipe file matches)
  └── Creative audit snapshot (current format/angle distribution)

Layer 3 — Conversation:
  └── Back-and-forth with Franzi, refinements, feedback
```

### Profile: `creative_strategist`

New profile in `src/agents/profiles/index.ts`:
```typescript
creative_strategist: [
  // Memory
  'recall', 'remember', 'search_memories',
  // Data (via Ada delegation + direct)
  'ask_ada',
  'get_creative_audit',          // P1 — current format/angle distribution
  'get_brief_performance',       // P5 — brief → ad performance link
  // Research
  'research_tiktok',             // P3 — TikTok Creative Center + trending
  'research_competitors',        // P3 — Ad Library competitor analysis
  'mine_reviews',                // P3 — own site + third-party + competitor reviews
  'search_methodology',          // existing — agency methodology knowledge
  // Creative
  'search_inspiration',          // P3 — smart swipe file search
  'save_inspiration',            // P3 — save to swipe file with auto-tags
  'analyze_creative',            // P4 — visual analysis (Gemini)
  'capture_screenshot',          // P4 — save screenshot for brief references
  'generate_hero_frame',         // P4 — AI image gen for brief storyboards
  // Slack
  'post_message', 'reply_in_thread',
  // Fireflies
  'search_meetings', 'get_meeting_summary', 'get_meeting_transcript',
  // Notion
  'query_tasks', 'create_task', 'update_task', 'search_notion',
  // Learning
  'save_learning',               // P6 — save global or client-specific learning
  'review_my_learnings',         // existing
  'correct_learning',            // existing
]
```

### Interaction Model

Maya lives in Slack. Entry points:
1. **@Maya in a channel** — concept requests, brief writing, research tasks
2. **DM to Maya** — strategy discussions, feedback, learning corrections
3. **Proactive alerts** — pipeline low, fatigue detected, diversity gaps (posts to designated channel)
4. **Client feedback detection** — monitors client Slack channels for brief/creative feedback

### Key Files (Target State)

| File | Purpose |
|------|---------|
| `agents/maya/agent.yaml` | Agent config (model, profile, channels) |
| `agents/maya/PERSONA.md` | Who Maya is, communication style |
| `agents/maya/CREATIVE-METHODOLOGY.md` | How Maya thinks about creative strategy |
| `agents/maya/FORMAT-REGISTRY.md` | Format × Angle creative coordinate system |
| `agents/maya/INSTRUCTIONS.md` | Tool reference, workflows, constraints |
| `agents/maya/clients/{code}.md` | Per-client creative context (brand, learnings, preferences) |
| `agents/_skills/ad-creative-brief.skill.md` | Brief writing knowledge (exists) |
| `agents/_skills/creative-qa.skill.md` | QC methodology (exists) |
| `agents/_skills/meta-ads-strategy.skill.md` | Hook frameworks, dials, testing (exists) |
| `src/agents/tools/creative-tools.ts` | Maya-specific tool implementations |
| `src/agents/tools/research-tools.ts` | TikTok, competitor, review mining tools |
| `src/agents/tools/visual-tools.ts` | Gemini vision analysis, screenshot, hero frame |

---

## Current State (as of March 2026)

**What exists:**
- `agents/maya/agent.yaml` — backlog status, `standard` profile, no channels
- `agents/maya/PERSONA.md` — good persona draft, references Ada collaboration
- `agents/maya/INSTRUCTIONS.md` — target behavior defined, not yet wired
- `agents/_skills/ad-creative-brief.skill.md` — comprehensive brief writing skill (239 lines)
- `agents/_skills/creative-qa.skill.md` — comprehensive QC methodology (216 lines)
- `agents/_skills/meta-ads-strategy.skill.md` — hook frameworks, dials, testing methodology
- `agents/_skills/meta-ads-compliance.skill.md` — Meta/TikTok policy compliance
- Ada's 6,469-row methodology knowledge base in Supabase
- BMAD creative infrastructure: scoring, grading, fatigue detection, concepts/briefs tables, inspiration library, creative API endpoints, format detection fields

**What Maya CANNOT do yet:**
- Not activated (backlog status)
- No `creative_strategist` profile
- No tools registered
- No format registry
- No client creative context files
- No visual analysis capability
- No research tools (TikTok, competitors, reviews)
- No learning-from-feedback system
- No creative audit / diversity scoring
- No brief → performance tracking
- No client feedback monitoring
- No proactive alerts

---

## The Creative Coordinate System

### Format = The Visual Container (HOW it's shot and edited)

What the viewer SEES. Determines production requirements. Independent of the message.

| ID | Format | Description | Production Needs | Typical Duration |
|----|--------|-------------|-----------------|-----------------|
| F01 | Talking Head | Single person, direct to camera | Creator, phone, clean bg | 15-60s |
| F02 | Interview / Podcast | 2+ people, conversation setup | 2 people, mics, set | 30-120s |
| F03 | Product Demo | Hands, product, macro shots, close-ups | Product, model, lighting | 15-45s |
| F04 | Unboxing / Reveal | Package opening, first reaction | Product in packaging, creator | 30-60s |
| F05 | Voiceover + B-roll | Narrator voice over lifestyle/product footage | B-roll footage, VO recording | 15-60s |
| F06 | Split Screen | Side-by-side comparison | Two scenes, editing | 15-30s |
| F07 | Screen Recording | Phone/app walkthrough | Screen capture | 15-45s |
| F08 | Documentary / Mini-Doc | Multiple shots, story arc | Multiple locations, editing | 60-180s |
| F09 | Reaction / Duet | Responding to another video | Source video, creator | 15-45s |
| F10 | ASMR / Sensory | Extreme close-ups, textures, sounds | Macro lens, good audio | 15-45s |
| F11 | Stop Motion / Animation | Animated frames or product movement | Animation/editing skill | 15-30s |
| F12 | Photo Slideshow | Multiple stills with transitions | Product photos, design | 15-30s |
| F13 | Compilation / Mashup | Multiple short clips assembled | Existing footage, editing | 30-60s |
| F14 | Static | Single image with text | Design, photography | — |
| F15 | Carousel | Multi-slide journey | Multiple designs, story arc | — |
| F16 | No-Ads Ad (Organic) | Looks like user-generated organic content | Creator, zero production feel | 15-60s |
| F17 | Two-Person | Behind-camera person interacting with on-camera person | 2 people, casual setup | 15-60s |

### Angle = The Persuasion Strategy (WHAT argument you're making)

The MESSAGE and psychological mechanism. Independent of visual format.

| ID | Angle | Psychological Mechanism | Example Core Message |
|----|-------|------------------------|---------------------|
| A01 | Problem → Solution | Pain agitation + relief | "I had X, this solved it" |
| A02 | Social Proof | Herd mentality, trust | "12,000 people switched" |
| A03 | Authority / Expert | Credibility transfer | "As a dermatologist..." |
| A04 | Founder Story | Authenticity, mission | "Why I built this" |
| A05 | Comparison / Us vs Them | Differentiation | "Unlike X, we do Y" |
| A06 | Education / How-To | Value-first, curiosity | "3 things you didn't know" |
| A07 | Lifestyle / Identity | Aspiration, belonging | "For women who value comfort" |
| A08 | Behind the Scenes | Transparency, trust | "How we actually make this" |
| A09 | Ingredient / Science | Rational persuasion | "The science behind this" |
| A10 | Use-Case / Occasion | Relevance, specificity | "Perfect for your morning" |
| A11 | Transformation | Before/after, proof | "What 30 days looks like" |
| A12 | Scarcity / FOMO | Urgency, loss aversion | "Limited run, 200 left" |
| A13 | Myth-Busting | Controversy, curiosity | "Everything you've been told is wrong" |
| A14 | Review / Testimonial | Social proof, specificity | "Real customer, real words" |
| A15 | Unboxing / First Impression | Discovery, excitement | "Let's see what's inside" |

### Style Modifiers (apply to any Format × Angle combination)

| Style | Description |
|-------|-------------|
| Lo-fi / Organic | Phone footage, natural light, imperfect, feels like organic content |
| Hi-fi / Polished | Studio quality, professional editing, branded |
| Energetic / Fast | Quick cuts, high energy, trending music |
| Calm / Soft | Slow pace, ASMR-adjacent, ambient |
| Funny / Comedic | Humor-driven, entertainment-first |
| Emotional / Story | Narrative arc, feelings-driven |
| Clinical / Scientific | Data-driven, clean, factual |
| Aspirational / Luxury | Premium feel, lifestyle-first |

### Hook Types (first 3 seconds — already defined in meta-ads-strategy.skill.md)

Pattern Interrupt, Curiosity Gap, Social Proof, Problem Agitation, Story, Authority/Credibility.

### Creative Coordinate Notation

Every concept is described as:
```
Format(F01: Talking Head) × Angle(A01: Problem→Solution) × Style(Lo-fi) × Hook(Question) × Funnel(TOF)
```

Not all combinations are equally effective. Performance data determines which coordinates work for each client. Over time, Maya's creative audit tracks the distribution and gaps.

---

## Phase 0: Format × Angle Registry + Creative Audit

**Goal:** Build the format registry data file and run a one-off creative audit of all active accounts to establish the current baseline.

**Prerequisites:** None — start here.

**Deliverables:**
1. `agents/maya/FORMAT-REGISTRY.md` — the creative coordinate system (formats, angles, styles, notation)
2. One-off creative audit script that maps current ad accounts
3. Creative audit snapshots stored in Supabase

### 0A. Create FORMAT-REGISTRY.md

Write `agents/maya/FORMAT-REGISTRY.md` containing:
- The format table (F01-F17) with descriptions, production needs, typical durations
- The angle table (A01-A15) with psychological mechanisms
- Style modifiers
- Hook types (reference meta-ads-strategy.skill.md)
- Creative coordinate notation explanation
- Compatibility notes (which format × angle combos are proven, which are untested)
- This file is loaded into Maya's system prompt — keep it compact (~3K tokens max)

### 0B. Creative Audit Script

Create `scripts/creative-audit.ts` that:
1. Queries BMAD Supabase for all active ads across all clients (last 30 days with spend > 0)
2. For each ad, pulls creative metadata from `creatives` table (format, transcript, thumbnail)
3. Uses Claude (Haiku) to classify each creative into Format × Angle × Style coordinates
4. Produces a per-client distribution report:
   - Format distribution (% of spend per format)
   - Angle distribution (% of spend per angle)
   - Style distribution
   - Gap matrix (untested combinations)
   - Top performers per coordinate
5. Saves audit to Supabase `creative_audits` table

### 0C. Supabase: `creative_audits` table

```sql
CREATE TABLE creative_audits (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_code TEXT NOT NULL,
  audit_date DATE NOT NULL DEFAULT CURRENT_DATE,
  format_distribution JSONB NOT NULL,    -- { "F01": { spend_pct: 0.45, count: 12, ... }, ... }
  angle_distribution JSONB NOT NULL,
  style_distribution JSONB NOT NULL,
  gap_matrix JSONB NOT NULL,             -- untested/underweight combos
  top_performers JSONB,                  -- top ads per coordinate
  total_spend NUMERIC,
  total_ads INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_creative_audits_client ON creative_audits(client_code, audit_date DESC);
```

### 0D. Workshop Prep

Before building: schedule a workshop with Franzi to:
- Validate the format list (are any missing? any that don't apply?)
- Validate the angle list
- Discuss the format vs angle distinction with real examples from current accounts
- Tag 20-30 existing ads together to calibrate the classification
- Identify any formats/angles unique to specific clients

**Run command:** `pnpm run creative-audit` (add to package.json scripts)

---

## Phase 1: Activate Maya Agent

**Goal:** Maya comes online as an active agent in Slack. Can generate concepts and write briefs using the format registry, client context, and existing skills.

**Prerequisites:** Phase 0 (format registry exists).

### 1A. Agent Config

Update `agents/maya/agent.yaml`:
```yaml
id: maya
display_name: Maya
model: claude-opus-4-6
icon: ":art:"
profile: creative_strategist
max_turns: 25
status: active
channels: []           # start with DM only, add channels after testing
sub_agents: []
skills:
  - ad-creative-brief
  - creative-qa
  - meta-ads-strategy
  - meta-ads-compliance
```

### 1B. New Profile

Add `creative_strategist` profile to `src/agents/profiles/index.ts`:
```typescript
creative_strategist: [
  'recall', 'remember', 'search_memories',
  'ask_ada',
  'search_methodology',
  'post_message', 'reply_in_thread',
  'search_meetings', 'get_meeting_summary', 'get_meeting_transcript',
  'query_tasks', 'create_task', 'update_task', 'search_notion',
],
```

Start minimal. More tools added in later phases.

### 1C. Rewrite PERSONA.md

Rewrite `agents/maya/PERSONA.md` to reflect the merged Pixel + Maya vision:
- Creative strategist AND visual analyst
- Expert in format × angle framework
- Uses data, research, and visual analysis to ground every decision
- Collaborative with Franzi (approvals), Ada (data), production team (feasibility)
- Proactive about diversity, gaps, and learning

### 1D. Write CREATIVE-METHODOLOGY.md

New file `agents/maya/CREATIVE-METHODOLOGY.md` — how Maya thinks about creative strategy:
- The creative coordinate system (reference FORMAT-REGISTRY.md)
- Concept generation methodology (format selection → angle selection → style → hooks)
- Iteration methodology (analyze WHY winners work → extract principles → apply in new coordinates)
- Diversity management (track distribution, flag gaps, suggest untested combos)
- The "Why It Works" requirement (every concept traces to data, research, or hypothesis)
- Brief quality principles (production feasibility, speakability, dial alignment)
- Learning philosophy (every brief is a test, every test is a learning)

### 1E. Write INSTRUCTIONS.md

Rewrite `agents/maya/INSTRUCTIONS.md` with:
- Tool reference (all available tools with usage guidance)
- Workflow: concept generation (ask_ada first → format selection → angle selection → hooks → brief)
- Workflow: iteration (get performance data → analyze why → extract principles → new coordinates)
- Workflow: brief writing (concept → full brief per skill spec → QC pass → deliver)
- Client context loading (how to use client files)
- Constraints (always ground in data, always "Why It Works", 3+ hook variants, production feasibility)
- Format diversity rule: "When generating 5+ concepts, ensure at least 3 different formats"

### 1F. Client Context Files

Create `agents/maya/clients/` directory. For each active client, create a `{code}.md` file containing:
- Brand overview (what the company does, products, target audience)
- Brand voice and visual identity (dos and don'ts)
- Past creative learnings (what worked, what failed, and WHY)
- Product lines (isolated context per product)
- Client-specific preferences extracted from calls and Slack
- Currently active creative coordinates (from Phase 0 audit)

Start with 3-4 key clients (Ninepine, Press London, Laori, T-Saft) and expand.

Source data: existing BMAD client files (`/Users/danielbulygin/dev/bmad/pma/clients/`), Fireflies transcripts, Ada's methodology knowledge.

### 1G. Register `ask_ada` Tool

Create `ask_ada` tool in `src/agents/tools/creative-tools.ts` that:
- Takes a natural language question about account performance
- Internally invokes Ada agent (via `ask_agent` pattern)
- Returns Ada's analysis
- Scoped: Maya always passes the client code

### 1H. Extras Loader

Ensure `agents/maya/` directory is picked up by the extras loader in `src/agents/tool-registry.ts` (already loads additional `.md` files from agent dirs into system prompt). Verify FORMAT-REGISTRY.md and CREATIVE-METHODOLOGY.md are auto-loaded.

### 1I. Router

Update `src/slack/router.ts` to route @Maya mentions and relevant keywords to Maya agent.

**Verification:** DM Maya in Slack → ask for 5 concepts for a client → verify she uses format × angle framework, asks Ada for data, produces structured concepts with "Why It Works."

---

## Phase 2: Ada ↔ Maya Integration + Creative Diversity Scoring

**Goal:** Maya can query live account data through Ada and assess creative diversity in real-time.

**Prerequisites:** Phase 1 (Maya active).

### 2A. `get_creative_audit` Tool

Create tool that queries the `creative_audits` table and returns the latest audit for a client:
- Format distribution with spend percentages
- Angle distribution
- Gap matrix (untested or underweight format × angle combos)
- Top performers per coordinate

Maya uses this to ground her concept proposals: "Your account is 70% Talking Head. Here are gaps worth testing."

### 2B. Live Creative Classification

Extend the nightly BMAD creative sync pipeline to auto-classify new ads into format × angle × style using Haiku. Store coordinates in BMAD `creatives` table:
- `format_code` (F01-F17)
- `angle_code` (A01-A15)
- `style_tags` (JSONB array)

This keeps the creative audit evergreen — no manual re-runs needed.

### 2C. Diversity Scoring Algorithm

In `src/agents/tools/creative-tools.ts`, implement `get_creative_diversity_score`:
- Input: client_code
- Queries active ads (last 7 days, spend > 0)
- Calculates:
  - Format entropy (Shannon entropy across format distribution — higher = more diverse)
  - Angle entropy
  - Concentration risk (any single format or angle > 60% of spend)
  - Gap count (format × angle combos never tested for this client)
- Returns: diversity score (0-100), concentration warnings, recommended gaps to test

### 2D. Concept Generation Workflow Integration

Update INSTRUCTIONS.md with the workflow:
1. Maya receives concept request for Client X
2. Calls `ask_ada("Current performance snapshot for {client}")` → gets data
3. Calls `get_creative_audit({client})` → gets format/angle distribution
4. Identifies gaps and opportunities
5. Proposes format/angle selections with rationale → Franzi approves
6. Generates concepts within approved coordinates
7. Writes full briefs per approved concepts

---

## Phase 2.5: Client Feedback Pipeline

**Goal:** Maya monitors client feedback channels, auto-generates brief revisions, with Franzi approval before delivery.

**Prerequisites:** Phase 1 (Maya active, generating briefs).

### 2.5A. Feedback Detection

Two input channels:

**Slack feedback monitoring:**
- Maya monitors designated client channels (configured per client in agent.yaml or client context file)
- Uses the existing channel monitoring pattern from Jasmin (15-min batch analysis)
- Haiku classifier detects messages that reference active briefs/concepts (by name, ad ID, or topic)
- When feedback detected: Maya generates a structured feedback summary

**Call transcript feedback:**
- Hook into existing Fireflies transcript ingestion pipeline (`src/learning/methodology-extractor.ts` pattern)
- After each client call, scan transcript for creative feedback
- Extract: which brief/concept, what the feedback was, who said it, sentiment

### 2.5B. Auto-Revision Generation

When feedback is detected:
1. Maya loads the original brief/concept (from Notion via search or from Supabase briefs table)
2. Maps the feedback to specific sections of the brief
3. Generates a revised version with changes highlighted (diff format)
4. Posts revision to Franzi with Block Kit approval buttons

### 2.5C. Approval Workflow

Slack Block Kit interactive message:
```
📝 *Client Feedback Detected* — Ninepine
> Kousha said: "The hook feels too salesy, can we make it more organic?"
> Source: Slack #ninepine-internal

*Original:* Hook A — "The leggings that 12,000 women can't stop buying"
*Revised:*  Hook A — "I wore these for a week straight and here's what happened"

[✅ Approve] [✏️ Edit] [❌ Reject] [🚫 Not Feedback]
```

**On Approve:** Revised brief is delivered (via Notion update or Slack post to team channel)
**On Edit:** Thread opens for Franzi to modify before sending
**On Reject:** Maya tries again with Franzi's notes
**On Not Feedback:** False positive — stored as negative training signal

### 2.5D. Feedback → Learning Pipeline

Every processed feedback item gets stored as a client learning:
- Category: `client_feedback`
- Client-scoped (not global)
- Examples: "Ninepine prefers organic-feeling hooks over social proof numbers", "Laori does not want morning-after angles"
- Pulled into Maya's client context for future concept generation
- Maya asks Franzi: "Should I save this as a permanent learning for {client}? [Yes / No]"

### 2.5E. Key Files

| File | Action |
|------|--------|
| `src/agents/tools/feedback-tools.ts` | Create — feedback detection, revision generation |
| `src/slack/listeners/maya-feedback-actions.ts` | Create — handle approval button clicks |
| `src/scheduler/maya-jobs.ts` | Create — scheduled feedback monitoring |
| `agents/maya/INSTRUCTIONS.md` | Update — feedback handling workflow |

---

## Phase 3: Research Tools

**Goal:** Maya can research TikTok trends, competitor ads, and mine reviews from multiple sources.

**Prerequisites:** Phase 1 (Maya active).

### 3A. TikTok Creative Center Integration

**Tool:** `research_tiktok`

Two capabilities:
1. **Top Ads** — query TikTok Creative Center API for top-performing ads by keyword, industry, region
   - Input: keyword, industry, region, time_range
   - Returns: top ads with metrics (likes, shares, views), video URLs, descriptions
   - Maya can then analyze these visually (Phase 4)

2. **Trending Content** — find viral organic videos by keyword
   - Input: keyword, hashtag
   - Returns: trending videos with engagement metrics
   - Source for format/hook inspiration

**Implementation options (evaluate in order of preference):**
1. TikTok Creative Center API (official, if available)
2. TikTok Ads Library API
3. Web scraping of TikTok Creative Center (headless browser via browse tools)
4. Manual: Maya asks the user to paste TikTok links, then analyzes them

### 3B. Competitor Ad Library Research

**Tool:** `research_competitors`

Leverages existing BMAD infrastructure:
- Facebook Ads Library API (already connected in BMAD)
- Input: competitor brand name or page ID, optional keyword filter
- Downloads recent competitor ads, transcribes video, extracts format/angle/hook
- Returns: structured competitor analysis with format distribution, top hooks, creative patterns
- Stores results in BMAD `inspiration_library` table

**BMAD endpoint to leverage:** `/api/creatives/analyze`, `/api/creatives/transcribe`

### 3C. Review Mining

**Tool:** `mine_reviews`

Three source types:
1. **Client's own website** — scrape product page reviews (input: product URL)
2. **Third-party** — Trustpilot, Amazon, Reddit (input: brand name, platform)
3. **Competitor reviews** — same sources but for competitor brands

**Output structure:**
```json
{
  "source": "trustpilot",
  "brand": "ninepine",
  "total_reviews": 342,
  "avg_rating": 4.6,
  "themes": [
    { "theme": "comfort", "frequency": 89, "sentiment": "positive", "sample_quotes": [...] },
    { "theme": "sizing", "frequency": 34, "sentiment": "mixed", "sample_quotes": [...] }
  ],
  "hook_worthy_quotes": [
    "I finally found leggings that don't go see-through",
    "My husband noticed the quality difference immediately"
  ],
  "pain_points": [...],
  "praise_points": [...]
}
```

The gold: **exact customer language** becomes hooks and ad copy. Better than anything Maya could invent.

### 3D. Smart Swipe File

**Tools:** `search_inspiration`, `save_inspiration`

Builds on existing BMAD `inspiration_library` table:
- `save_inspiration` — save an ad URL with auto-classification (format, angle, hook type, style)
- `search_inspiration` — find inspiration by format, angle, client relevance, or free-text search
- Auto-tagging via Haiku: when an ad is saved, it gets classified into creative coordinates
- Client relevance scoring: "This competitor ad is relevant to Ninepine because it targets the same demographic with a similar product"

### 3E. Key Files

| File | Action |
|------|--------|
| `src/agents/tools/research-tools.ts` | Create — TikTok, competitor, review mining implementations |
| `src/agents/tools/inspiration-tools.ts` | Create — swipe file search/save |
| `src/agents/profiles/index.ts` | Update — add research tools to creative_strategist profile |
| `agents/maya/INSTRUCTIONS.md` | Update — research workflow guidance |

---

## Phase 4: Visual Intelligence (Pixel Merged into Maya)

**Goal:** Maya can see and analyze ads, capture screenshots for brief references, and generate AI hero frames.

**Prerequisites:** Phase 1 (Maya active).

### 4A. Creative Visual Analysis

**Tool:** `analyze_creative`

Uses **Gemini** (best model for visual analysis) to analyze ad creatives:
- Input: image URL, video URL, or local file path
- Gemini analyzes and returns structured output:
  - Format classification (F01-F17)
  - Visual composition (layout, color palette, text placement, product visibility)
  - Hook analysis (first frame, text overlay, pattern interrupt elements)
  - Production quality assessment (lo-fi vs hi-fi, lighting, editing style)
  - Emotional tone (energetic, calm, aspirational, etc.)
  - Text extraction (all on-screen text)
  - Estimated dial settings (authenticity, production complexity, DR intensity, product clarity)

**Implementation:**
- Use Gemini API (`@google/generative-ai` SDK) with `gemini-2.0-flash` or `gemini-2.5-pro` for vision
- For videos: extract key frames (first frame, 3s, mid-point, CTA frame) and analyze as image set
- Store analysis results in BMAD `creatives` table or new `creative_analyses` table

### 4B. Screenshot Capture

**Tool:** `capture_screenshot`

Saves screenshots from various sources for use as visual references in briefs:
- Input: URL (ad, website, TikTok video), optional crop/frame parameters
- Captures screenshot using headless browser (Puppeteer/Playwright)
- Saves to storage (BMAD Supabase Storage or local)
- Returns: screenshot URL/path that can be embedded in briefs

Use cases:
- "Here's the competitor ad we're remixing" (screenshot from Ad Library)
- "This is the visual style we're going for" (screenshot from TikTok)
- "Current best performer for reference" (screenshot from Ads Manager)

### 4C. AI Hero Frame Generation

**Tool:** `generate_hero_frame`

Generates AI images to use as visual references / storyboards in briefs:
- Input: description of the scene, style parameters, aspect ratio
- Uses image generation API (Gemini Imagen, or alternative)
- Returns: generated image URL/path
- Purpose: give creators and editors a visual reference of the intended look/feel

Franzi noted this is nice-to-have, not essential for no-ads-ads style. Maya should suggest hero frames only when the concept benefits from visual direction (e.g., studio shoots, specific set designs).

### 4D. Brief Visual References

Update brief writing workflow to optionally include:
- Screenshot of inspiration ad (competitor or own best performer)
- AI-generated hero frame / storyboard frame
- Reference links to Ad Library or TikTok videos

These get embedded in the Notion brief or delivered as attachments in Slack.

### 4E. Iteration Engine (Visual)

The iteration workflow now includes visual analysis:
1. Maya calls `analyze_creative(best_performer_url)` → gets visual analysis
2. Extracts WHY the creative works (visual composition, hook mechanics, emotional triggers)
3. Identifies which ELEMENTS to keep vs change
4. Generates new concepts that apply the winning principles in different coordinates
5. Example: "The bold headline + product hero composition works. Let's keep that layout but change the angle from Problem→Solution to Testimonial"

### 4F. Key Files

| File | Action |
|------|--------|
| `src/agents/tools/visual-tools.ts` | Create — Gemini vision, screenshot, hero frame |
| `src/agents/profiles/index.ts` | Update — add visual tools to creative_strategist profile |
| `agents/maya/INSTRUCTIONS.md` | Update — visual analysis workflow, iteration methodology |

---

## Phase 5: Closed Learning Loop (Brief → Performance)

**Goal:** Connect briefs to ad performance via ad ID, so Maya learns which of her concepts/briefs produce winners.

**Prerequisites:** Phase 1 (Maya active), Phase 2 (Ada integration).

### 5A. Brief-to-Ad Linking

Every brief already has a unique ad ID (stored in Notion). The BMAD ad data also has ad IDs/names. The connection:

1. When Maya writes a brief, she records the ad ID in Supabase:
```sql
CREATE TABLE brief_tracking (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  brief_id TEXT NOT NULL,                    -- Notion brief ID or ad ID
  ad_id TEXT,                                -- Meta ad ID (filled when ad goes live)
  client_code TEXT NOT NULL,
  format_code TEXT,                          -- F01-F17
  angle_code TEXT,                           -- A01-A15
  style_tags JSONB,
  hook_types JSONB,
  concept_summary TEXT,
  why_it_works TEXT,
  status TEXT DEFAULT 'drafted',             -- drafted → produced → live → scored
  performance_score NUMERIC,                 -- filled after scoring
  performance_grade TEXT,                    -- A-F
  performance_data JSONB,                    -- hook_rate, hold_rate, ctr, roas, etc.
  scored_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_brief_tracking_client ON brief_tracking(client_code);
CREATE INDEX idx_brief_tracking_ad ON brief_tracking(ad_id);
```

2. When an ad goes live, match brief_id to ad via naming convention or manual linking
3. After 7 days of data, score the brief's performance

### 5B. `get_brief_performance` Tool

Maya queries brief tracking to learn from her own history:
- Input: client_code, optional format_code, angle_code
- Returns: past briefs with performance scores, grouped by coordinate
- Maya sees: "My Talking Head × Problem→Solution briefs average a B+ for Ninepine but C- for Laori"

### 5C. Auto-Scoring Job

Scheduled job (`src/scheduler/maya-jobs.ts`):
- Runs daily at midnight
- Finds all `brief_tracking` entries with status `live` and `scored_at` is NULL and ad has 7+ days of data
- Pulls performance from BMAD via ad_id
- Calculates performance score using creative grading system (from BMAD creative intelligence spec)
- Updates brief_tracking with score, grade, and performance data

### 5D. Learning Integration

When a brief is scored:
- If grade A/B: save as positive learning ("Talking Head × Problem→Solution with lo-fi style produced an A for Ninepine — hook rate 38%, ROAS 4.2x")
- If grade D/F: save as negative learning ("Documentary × Education with hi-fi style failed for Press London — hook rate 12%, possible cause: too long for TOF audience")
- These learnings feed into Maya's client context and influence future concept generation

---

## Phase 6: Human Feedback Learning System

**Goal:** Maya learns from human feedback, identifies root causes, saves learnings (global or client-specific), and improves over time. Humans act as product managers for Maya.

**Prerequisites:** Phase 1 (Maya active).

### 6A. Feedback Signal Detection

Maya detects learning opportunities from multiple sources:

| Signal | Source | Detection Method |
|--------|--------|-----------------|
| Franzi edits a concept/brief | Slack thread | Maya notices changes between her draft and approved version |
| Franzi rejects a concept | Slack reaction or message | ❌ reaction or "this doesn't work because..." |
| Franzi praises a concept | Slack reaction | ✅ 🔥 ⭐ reactions |
| Client feedback on a brief | Slack channel (Phase 2.5) | Detected via feedback monitoring |
| Creative performance data | Phase 5 scoring | Auto-scored after 7 days |
| Explicit feedback | "Maya, remember that..." | Direct instruction |
| Call transcript insight | Fireflies | Creative feedback extracted from client calls |

### 6B. Root Cause Analysis

When Maya receives negative feedback, she doesn't just record "concept rejected." She:
1. Analyzes WHAT was wrong (hook too generic? wrong format? doesn't match brand?)
2. Identifies the ROOT CAUSE (missing client context? wrong assumption? format mismatch?)
3. Proposes a learning with the root cause
4. Asks the human: "I think the issue was [X]. Should I save this as a learning?"

### 6C. Learning Classification

Maya proposes learning with classification:
```
🧠 *Learning Detected*
> Franzi changed the hook from social proof to problem agitation for Laori Drops.
> Root cause: Laori's audience responds better to pain points than numbers.

*Proposed learning:* "For Laori Drops, problem-agitation hooks outperform social proof hooks — audience responds to emotional pain points, not statistics."

*Classification:*
[🌍 Global] [👤 Client: Laori] [📦 Product: Drops]
[💾 Save] [✏️ Edit] [🚫 Skip]
```

### 6D. Learning Storage & Retrieval

Stored in existing `learnings` table with:
- `category`: `creative_learning` (new category)
- `client_code`: NULL (global) or specific client code
- `product_line`: NULL (all products) or specific product
- `content`: the learning text
- `confidence`: starts at 0.5, increases with confirmation, decays with time
- `source`: `human_feedback`, `performance_data`, `call_transcript`

Retrieved during concept generation: Maya automatically pulls relevant learnings for the current client + product + format + angle.

### 6E. Learning Management Tools

**Tool:** `save_learning` — save a global or client-specific learning with classification
**Existing tools:** `review_my_learnings`, `correct_learning`, `delete_learning`

Humans can also:
- Ask Maya "What have you learned about Ninepine?" → Maya shows all Ninepine learnings
- Tell Maya "That learning is wrong because..." → Maya corrects
- Tell Maya "Forget that, we changed strategy" → Maya deletes

### 6F. Weekly Learning Synthesis

Scheduled job (Sunday, similar to Ada/Jasmin pattern):
- Review all new learnings from the past week
- Merge duplicates, resolve conflicts
- Strengthen confirmed patterns
- Decay unconfirmed hypotheses
- Generate "Maya's Weekly Learning Report" for Franzi

---

## Phase 7: Proactive Monitoring & Alerts

**Goal:** Maya proactively monitors creative pipeline health and alerts when action is needed.

**Prerequisites:** Phase 2 (diversity scoring), Phase 5 (brief tracking).

### 7A. Pipeline Monitor

Scheduled job (daily, 9am):
- For each active client, count: active ads, ads in production, briefs awaiting approval
- Alert conditions:
  - "Ninepine has only 3 active creatives and 0 in production — pipeline is empty"
  - "Press London's testing campaign has no new ads in 14 days"
  - "Laori has 5 briefs awaiting approval for 7+ days"

### 7B. Fatigue Alerts

Connects to BMAD creative fatigue detection:
- When a top-performing creative shows fatigue signals (hook rate declining 7+ days, frequency > 3.0)
- Maya proactively generates iteration concepts: "Your top performer for Ninepine is fatiguing. Here are 3 iteration concepts that apply the same winning principles in new formats."

### 7C. Diversity Alerts

Weekly check:
- If any client's active creative mix has format concentration > 60%: alert
- If any client hasn't tested a new format in 30+ days: alert
- If any format × angle combo has been producing winners across other clients but isn't tested for this client: suggest

### 7D. Weekly Creative Digest

Scheduled job (Monday morning, after Ada's weekly reflection):
- Cross-account creative report for Franzi
- What was tested last week, what won, what failed
- Format/angle trends across all clients
- Recommendations for this week
- New formats/angles observed in competitor analysis

### 7E. Key Files

| File | Action |
|------|--------|
| `src/scheduler/maya-jobs.ts` | Create — all Maya scheduled jobs |
| `src/agents/tools/monitoring-tools.ts` | Update — add creative pipeline monitoring |
| `agents/maya/INSTRUCTIONS.md` | Update — proactive alert behavior |

---

## Phase 8: Client Deliverables

**Goal:** Maya produces shareable artifacts for clients and internal team.

**Prerequisites:** Phase 2 (data integration), Phase 5 (brief tracking).

### 8A. Testing Roadmap Generator

**Tool:** `create_testing_roadmap`

Generates a structured testing plan:
- Input: client_code, time_horizon (default 2 months), budget_context
- Output: Markdown document with:
  - Strategic overview (current state, opportunities, gaps)
  - Format × angle selections for this period with rationale
  - Concept previews (name, coordinate, "Why It Works" summary)
  - Timeline (week by week: what's being tested, what's being scaled)
  - Success criteria per concept
  - Visual: format distribution before (current) vs after (planned)

Can be exported to Notion or shared as a document.

### 8B. Monthly Creative Report

Scheduled job (1st of month):
- Per-client report: what was tested, performance grades, learnings, next month's direction
- Cross-account report: agency-wide trends, format winners, angle insights
- Delivered to Franzi via Slack + saved in Notion

### 8C. Concept Deck

When Maya generates a batch of concepts, optionally produce a structured "deck" format:
- One concept per section
- Includes: coordinate, "Why It Works", hook previews, visual references, inspiration links
- Shareable with clients for sign-off

---

## Phase 9: Cross-Account Intelligence

**Goal:** Maya leverages patterns across ALL clients for agency-level advantage.

**Prerequisites:** Phase 2 (audits exist for all clients), Phase 5 (brief performance data).

### 9A. Cross-Account Pattern Detection

Scheduled analysis (weekly):
- Query brief_tracking across all clients
- Identify: "Interview format is producing A-grade results for 3 clients — worth testing for clients who haven't tried it"
- Find: global format/angle trends, seasonal patterns
- Store as global learnings (not client-specific)

### 9B. Cross-Account Diversity Comparison

Tool: `get_agency_creative_overview`
- Returns: format/angle distribution across all clients
- Highlights: which clients are most diverse, which are stuck in ruts
- Suggests: cross-pollination opportunities

### 9C. Trend Detection

Over time, Maya can detect:
- Rising formats (e.g., "No-Ads Ads are producing 2x hook rates across 4 clients this month")
- Declining formats (e.g., "Standard UGC talking head performance is declining across the board")
- Seasonal patterns (e.g., "Authority angles perform best in Q1 for health/wellness clients")

---

## Phase 10: Web Interface

**Goal:** Non-technical users interact with Maya through a web UI instead of Claude Code.

**Prerequisites:** All core phases complete.

### 10A. Extend Brief Studio (BMAD)

The BMAD Brief Studio spec already describes a web app for brief creation. Extend it to be Maya's primary interface:
- Chat interface for strategy discussions
- Concept review with approval buttons
- Brief editor with Maya's suggestions
- Format registry browser
- Creative audit dashboard
- Inspiration library with drag-and-drop

### 10B. Notion Integration

Until the web UI is built, Notion serves as the primary document layer:
- Maya creates/updates briefs in Notion
- Clients and team see briefs in Notion
- Feedback from Notion comments feeds into Maya's learning pipeline

---

## Dependency Graph

```
P0 (Format Registry + Audit)
 ├── P1 (Activate Maya) ──────────────────────────┐
 │    ├── P2 (Ada Integration + Diversity) ────────┤
 │    │    ├── P2.5 (Client Feedback Pipeline)     │
 │    │    ├── P5 (Closed Learning Loop)           │
 │    │    │    └── P7 (Proactive Monitoring)      │
 │    │    │    └── P8 (Client Deliverables)       │
 │    │    └── P9 (Cross-Account Intelligence)     │
 │    ├── P3 (Research Tools) ─────────────────────┤
 │    ├── P4 (Visual Intelligence) ────────────────┤
 │    └── P6 (Human Feedback Learning) ────────────┤
 │                                                 │
 └─────────────────────────────────────────────────┘
                                                    → P10 (Web Interface)
```

**Parallelizable after P1:** P2, P3, P4, P6 can all be built in parallel.
**Sequential:** P5 needs P2. P7/P8 need P5. P9 needs P2+P5.

---

## Session Strategy

Each implementation session should:
1. Read this spec first
2. Pick ONE phase (or sub-phase like 1A-1I)
3. Read the referenced files listed for that phase
4. Implement, test, verify
5. Update this spec with ✅ status and any learnings

**Critical rule:** Do NOT modify phases you are not implementing. Update only the phase you completed.

---

## Appendix A: Existing Infrastructure to Leverage

### From DAI:
- Agent runner with tool-use loop: `src/agents/runner.ts`
- Tool registry pattern: `src/agents/tool-registry.ts`
- Profile system: `src/agents/profiles/index.ts`
- Extras loader (auto-loads .md files from agent dirs)
- Memory tools: recall, remember, search_memories
- Methodology search: search_methodology (6,469 rows)
- Fireflies tools: search_meetings, get_meeting_summary, get_meeting_transcript
- Slack tools: post_message, reply_in_thread
- Notion tools: query_tasks, create_task, update_task, search_notion
- Channel monitoring pattern (from Jasmin)
- Learning system: learnings table, extraction, synthesis, decay
- Client context loading pattern (from Ada client-facing agents)
- Block Kit approval workflow pattern (from Jasmin triage + Ada insight approval)
- Scheduler: `src/scheduler/` for cron jobs

### From BMAD:
- Creative scoring (Hook/Watch/Click/Convert): `pma/dashboard/src/lib/creative-analytics/scores.ts`
- Creative grading (A-F): `pma/docs/creative-intelligence-feature-spec.md`
- Fatigue detection: `pma/dashboard/src/lib/creative-analytics/fatigue.ts`
- Concepts + briefs tables: `pma/database/migrations/002_concepts_briefs.sql`
- Inspiration library: `pma/dashboard/migrations/003_inspiration_library.sql`
- Creative API endpoints: `/api/creatives/*` (analyze, score, remix, transcribe, sync)
- Format detection fields: `pma/dashboard/supabase/migrations/20260118_creative_format_detection.sql`
- Client strategy docs: `pma/clients/{name}/client-strategy.md`
- Marco agent (creative strategist): `pma/agents/creative-strategist.md`
- Tag taxonomy: format, hook, angle, CTA, visual tags defined in creative intelligence spec

### From Existing Skills:
- `ad-creative-brief.skill.md` — 239 lines, comprehensive brief structure
- `creative-qa.skill.md` — 216 lines, QC methodology
- `meta-ads-strategy.skill.md` — hook frameworks, dials, testing methodology
- `meta-ads-compliance.skill.md` — platform policy compliance

---

## Appendix B: Key Supabase Tables (Target State)

### DAI Supabase (fgwzscafqolpjtmcnxhn):
- `creative_audits` — format/angle distribution snapshots per client (Phase 0)
- `brief_tracking` — brief → ad → performance link (Phase 5)
- `learnings` — existing table, extended with `creative_learning` category (Phase 6)

### BMAD Supabase (bzhqvxknwvxhgpovrhlp):
- `creatives` — add `format_code`, `angle_code`, `style_tags` columns (Phase 2)
- `inspiration_library` — existing table, add auto-tagging fields (Phase 3)
- `concepts` — existing table
- `briefs` — existing table
