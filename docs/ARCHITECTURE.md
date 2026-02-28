# DAI - Daniel's AI: Multi-Agent Slack System

## Context

Daniel wants to build a Slack-based multi-agent system where AI agents with distinct personas live in Slack, users interact with them via @mentions/DMs/commands, agents can collaborate with each other in channels, and the system learns from feedback. Inspired by OpenClaw (gateway/session model), claude-mem (memory compression), Superpowers (skills/subagent pipelines), and BMAD (agent personas/modules/workflows).

**Stack**: TypeScript, Node.js 22+, @anthropic-ai/sdk, @slack/bolt (Socket Mode), Supabase (PostgreSQL), pnpm

---

## Phase 1: Project Bootstrap

### 1.1 Create GitHub repo + initialize project
- `gh repo create danielbulygin/dai --private --clone`
- `pnpm init`, install dependencies
- Configure `tsconfig.json` (ESM, strict, Node22 target)
- `tsup.config.ts` for builds, `vitest` for tests
- `.env.example` with all required env vars
- `.gitignore` (node_modules, dist, data/, .env)

### 1.2 Dependencies
```
Production: @anthropic-ai/claude-agent-sdk, @slack/bolt, @slack/web-api,
            better-sqlite3, gray-matter, js-yaml, nanoid, pino, zod
Dev:        @types/better-sqlite3, @types/js-yaml, @types/node,
            tsup, tsx, typescript, vitest, prettier
```

### 1.3 Create CLAUDE.md
- Project overview, architecture, conventions
- Explicitly allow sub-agents and agent teams
- Define learning loop expectations
- Key file paths and patterns

---

## Phase 2: Slack Foundation

### 2.1 `src/env.ts` - Zod-validated environment config
### 2.2 `src/utils/logger.ts` - Pino structured logging
### 2.3 `src/slack/app.ts` - Bolt App with Socket Mode
### 2.4 `src/slack/listeners/mentions.ts` - `app_mention` handler
### 2.5 `src/slack/listeners/messages.ts` - DM handler
### 2.6 `src/index.ts` - Entry point, boot sequence

**Verify**: Bot connects to Slack, responds to @mention with "Hello!"

---

## Phase 3: Agent System

### 3.1 Agent definition format (`agents/<name>/`)
Each agent directory contains:
- `agent.yaml` - Config (model, tools, slack channels, sub-agents, icon)
- `PERSONA.md` - Identity, communication style, principles
- `INSTRUCTIONS.md` - Operating instructions, routing logic

### 3.2 Agent manifest (`agents/_manifest.yaml`)
Registry of all agents with id, path, display_name, icon, description, tags

### 3.3 Starter agents
| Agent | Name | Role | Icon | Tools |
|-------|------|------|------|-------|
| `otto` | Otto | Team Orchestrator (default) | :robot_face: | standard (no write/edit/bash) |
| `coda` | Coda | Senior Developer | :technologist: | coding (full) |
| `rex` | Rex | Research Specialist | :mag: | readonly + web |
| `sage` | Sage | Quality Reviewer | :owl: | readonly |

### 3.4 Core source files
- `src/agents/registry.ts` - Load agent YAML/MD, validate with zod
- `src/agents/runner.ts` - Execute agent via Claude SDK `query()`
- `src/agents/profiles/` - Tool profiles (readonly, standard, coding, full)
- `src/agents/tools/` - Custom MCP tools (slack, memory, agent, knowledge)
- `src/orchestrator/router.ts` - Route Slack events to correct agent
- `src/orchestrator/session-manager.ts` - Session lifecycle

### 3.5 Message streaming to Slack
- `src/slack/formatters/chunker.ts` - Break long responses into chunks (300-3000 chars)
- `src/slack/formatters/markdown-to-mrkdwn.ts` - Convert markdown to Slack format
- Progressive update: post initial message, update via `chat.update`, chunk if too long

---

## Phase 4: Memory & Persistence

### 4.1 Supabase (PostgreSQL) schema
Two Supabase projects:
- **DAI Supabase** (fgwzscafqolpjtmcnxhn): sessions, observations, summaries, learnings, messages, feedback, decisions, meetings, meeting_sentences, transcript_ingestion_log, methodology_knowledge, pending_insights
- **BMAD Supabase** (bzhqvxknwvxhgpovrhlp): clients, ad account data, alerts, client_configs

Core tables:
- `sessions` - Agent sessions (channel, thread, claude_session_id, summary, cost)
- `observations` - Raw tool observations (tool_name, input/output summaries, importance)
- `summaries` - AI-compressed session/daily/weekly summaries
- `learnings` - Extracted learnings (category, confidence, applied_count, client_code)
- `feedback` - User reactions/feedback (type, sentiment, processed flag)

Full-text search via tsvector + GIN indexes + RPC functions (search_observations, search_learnings, search_meetings, search_methodology).

### 4.2 SDK Hooks
- `memory-capture.ts` (PostToolUse) - Capture tool observations
- `session-lifecycle.ts` (SessionStart/Stop) - Inject context, summarize
- `slack-notifier.ts` (Notification) - Stream status to Slack
- `security.ts` (PreToolUse) - Block dangerous operations
- `subagent-tracker.ts` (SubagentStart/Stop) - Track child agents

### 4.3 3-Layer progressive disclosure
- **Layer 1** (always injected): Last session summary, top learnings (~200 tokens)
- **Layer 2** (via tools): FTS5 search via `recall()` and `search_memories()`
- **Layer 3** (deep): `load_knowledge()`, `get_session_details()`

---

## Phase 5: Agent-to-Agent Communication

### 5.1 Slack-visible delegation (transparent)
- Otto posts "@Coda [task]" in thread, Coda processes and responds

### 5.2 Internal sub-agents (invisible)
- Claude SDK `agents: {}` config for behind-the-scenes work

### 5.3 Concurrency control
- Max 5 concurrent agents, per-channel rate limiting

---

## Phase 6: Learning Loops

### 6.1 Feedback: :thumbsup:/:thumbsdown: reactions -> learning records
### 6.2 Self-reflection: Post-session "what could improve?" analysis
### 6.3 Team learnings: Aggregate across sessions, inject into all agents

---

## Fireflies Meeting Pipeline

End-to-end system for capturing, storing, deduplicating, and extracting insights from Fireflies.ai call transcripts.

### Data Flow

```
Fireflies.ai (call recorded)
  │
  ├─► Webhook (real-time)              POST to /functions/v1/fireflies-webhook
  │     { meetingId, eventType }        Fetches full meeting, upserts, deduplicates
  │
  └─► Cron sync (every 3h, safety net) /functions/v1/sync-fireflies
        Lists new meetings, fetches details, upserts, deduplicates
  │
  ▼
DAI Supabase: `meetings` + `meeting_sentences` tables
  │
  ▼  (Sunday 8am Berlin, src/learning/transcript-ingestor.ts)
Pattern matching (src/learning/meeting-patterns.ts)
  → Claude Sonnet extracts insights (account_insight, methodology, creative, etc.)
  → Deduplicates against existing learnings (60% word overlap threshold)
  │
  ▼
DAI Supabase: `learnings` table (agent_id='ada', client_code, confidence)
  │
  ▼  (Sunday 9am Berlin, src/learning/learning-synthesizer.ts)
Claude Opus merges duplicates, deprecates stale learnings, adjusts confidence
  │
  ▼
Injected into Ada's context at query time via search_learnings()
```

### Storage (DAI Supabase — fgwzscafqolpjtmcnxhn)

| Table | Purpose | Key fields |
|-------|---------|------------|
| `meetings` | One row per call | id, title, date, organizer_email (= transcript source), speakers[], full_transcript, FTS vectors |
| `meeting_sentences` | Sentence-level transcript | meeting_id (CASCADE), speaker_name, text, start/end_time |
| `sync_state` | Singleton tracking sync progress | last_synced_at, total_synced |
| `transcript_ingestion_log` | Prevents re-extracting insights from same meeting | meeting_id (UNIQUE), pattern_id, insights_extracted |
| `learnings` | Extracted insights used by agents | agent_id, category, content, confidence, client_code, applied_count |
| `methodology_knowledge` | Bulk-extracted rules/patterns from Nina-Daniel calls | type (rule/insight/decision/creative_pattern/methodology), body (JSONB), account_code |

### Deduplication

Multiple Fireflies bots can record the same call (each participant's bot creates a separate transcript). The `dedup_meetings()` RPC function runs after every sync:
- Groups meetings by (same title, date within 10 minutes)
- Keeps Daniel's copy (`organizer_email = daniel.bulygin@gmail.com`) as canonical
- If Daniel wasn't in the meeting, keeps the copy with the lowest ID
- `meeting_sentences` cascade-delete automatically

The `organizer_email` field indicates whose Fireflies bot recorded the transcript — it's the **source** of that copy, not necessarily the meeting organizer.

### Edge Functions

| Function | Trigger | Purpose |
|----------|---------|---------|
| `sync-fireflies` | pg_cron every 3h | Lists new meetings from Fireflies API, fetches details, upserts, deduplicates |
| `fireflies-webhook` | Fireflies webhook POST | Real-time: receives meetingId, fetches details, upserts, deduplicates |

### Search RPCs

| Function | Used by | How |
|----------|---------|-----|
| `search_meetings(query, from_date, to_date, speaker_filter)` | Ada, Jasmin (via `search_meetings` tool) | FTS on summary (2x boost) + transcript |
| `search_learnings(query, client_code_filter)` | Ada (via `search_learnings` tool) | FTS on learnings, client-specific 2x boost |
| `search_methodology(query, type_filter, account_filter)` | Ada (via `search_methodology` tool) | FTS on methodology_knowledge, account-specific boost |

### Key Files

| File | Role |
|------|------|
| `supabase/functions/sync-fireflies/index.ts` | Cron sync edge function |
| `supabase/functions/fireflies-webhook/index.ts` | Webhook receiver edge function |
| `src/learning/transcript-ingestor.ts` | Sunday insight extraction (Claude Sonnet) |
| `src/learning/meeting-patterns.ts` | Which meetings to extract insights from |
| `src/learning/learning-synthesizer.ts` | Sunday merge/dedup of learnings (Claude Opus) |
| `src/agents/tools/fireflies-tools.ts` | Agent tools: searchMeetings, getMeetingTranscript, etc. |
| `supabase/migrations/20260228100000_dedup_meetings.sql` | dedup_meetings() RPC function |

---

## Phase 7: Skills & Knowledge

### 7.1 Skills as `.skill.md` files with YAML frontmatter
### 7.2 Shared knowledge base with selective loading
### 7.3 Starter skills: code-review, summarize, research

---

## Directory Structure

```
dai/
├── CLAUDE.md
├── package.json / tsconfig.json / tsup.config.ts
├── .env.example / .gitignore
├── src/
│   ├── index.ts                    # Entry point
│   ├── env.ts                      # Zod env validation
│   ├── slack/
│   │   ├── app.ts                  # Bolt Socket Mode init
│   │   ├── listeners/              # mentions, messages, commands, reactions
│   │   ├── middleware/             # auth, rate-limit
│   │   └── formatters/            # chunker, markdown-to-mrkdwn, block-kit
│   ├── orchestrator/
│   │   ├── router.ts              # Event -> agent routing
│   │   ├── session-manager.ts     # Session lifecycle
│   │   ├── agent-to-agent.ts      # Inter-agent protocol
│   │   └── queue.ts               # Concurrency control
│   ├── agents/
│   │   ├── registry.ts            # Load agent definitions
│   │   ├── runner.ts              # Claude SDK query() wrapper
│   │   ├── hooks/                 # memory-capture, session-lifecycle, security
│   │   ├── tools/                 # Custom MCP: slack, memory, agent, knowledge
│   │   └── profiles/             # Tool sets: readonly, standard, coding, full
│   ├── memory/
│   │   ├── db.ts                  # SQLite + migrations
│   │   ├── schema.ts             # Table definitions
│   │   ├── observations.ts / summaries.ts / sessions.ts / learnings.ts
│   │   ├── search.ts             # 3-layer progressive search
│   │   └── compression.ts        # AI compression pipeline
│   ├── learning/
│   │   ├── feedback.ts            # Process reactions/feedback
│   │   ├── self-reflection.ts     # Post-session self-assessment
│   │   └── team-learnings.ts      # Cross-agent knowledge transfer
│   ├── skills/
│   │   ├── loader.ts              # Parse SKILL.md files
│   │   └── validator.ts           # Validate skills
│   └── utils/
│       ├── logger.ts / config.ts / errors.ts / token-counter.ts
├── agents/                         # Agent definitions (data, not code)
│   ├── _manifest.yaml
│   ├── _teams/                    # Team configs
│   ├── _skills/                   # Shared skills
│   ├── _knowledge/                # Shared knowledge base
│   ├── otto/ coda/ rex/ sage/     # Individual agent dirs
├── data/                           # Runtime (gitignored)
├── scripts/
│   ├── setup.ts / migrate.ts / seed-agents.ts
└── tests/
```

---

## Key Design Decisions

1. **Single Slack App** with persona switching via `username`/`icon_emoji` (simpler than multiple apps)
2. **Claude SDK V1 `query()`** (V2 is unstable preview)
3. **SQLite** (zero infra, FTS5 built-in, single-server is fine)
4. **Agent definitions as data** (YAML/MD files, version-controlled)
5. **Both visible and invisible** sub-agent patterns supported
6. **`bypassPermissions`** mode since this runs server-side; security via hooks
