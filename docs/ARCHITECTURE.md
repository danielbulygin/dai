# DAI - Daniel's AI: Multi-Agent Slack System

## Context

Daniel wants to build a Slack-based multi-agent system where AI agents with distinct personas live in Slack, users interact with them via @mentions/DMs/commands, agents can collaborate with each other in channels, and the system learns from feedback. Inspired by OpenClaw (gateway/session model), claude-mem (memory compression), Superpowers (skills/subagent pipelines), and BMAD (agent personas/modules/workflows).

**Stack**: TypeScript, Node.js 22+, Claude Agent SDK, @slack/bolt (Socket Mode), SQLite, pnpm

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

### 4.1 SQLite schema (5 tables + FTS5)
- `sessions` - Agent sessions (channel, thread, claude_session_id, summary, cost)
- `observations` - Raw tool observations (tool_name, input/output summaries, importance)
- `summaries` - AI-compressed session/daily/weekly summaries
- `learnings` - Extracted learnings (category, confidence, applied_count)
- `feedback` - User reactions/feedback (type, sentiment, processed flag)

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
