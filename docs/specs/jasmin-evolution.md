# Jasmin Evolution — Master Specification

> This document is the single source of truth for Jasmin's evolution. Each phase is self-contained — a fresh Claude session can read this spec + the referenced files and execute any phase independently.

## Vision

Jasmin evolves from a capable assistant into Daniel's **always-on chief of staff**: managing his calendar, triaging email, sending messages on his behalf, running morning/EOD briefings, proactively surfacing what matters, and learning his preferences over time — all running 24/7 on DigitalOcean.

## Current State (as of Feb 2026)

**What Jasmin has (21 tools, `assistant` profile):**
- Memory: recall, remember, search_memories (3)
- Delegation: ask_agent → Otto → specialists (1)
- Slack messaging: post_message, reply_in_thread, send_as_daniel, read_dms (4)
- Fireflies meetings: search, summary, transcript, list_recent (4)
- Notion tasks: query, create, update, comment, search (5)
- Channel monitoring: get_channel_insights, get_recent_mentions, get_monitoring_history (3)
- Briefings: generate_briefing — morning/EOD, persisted to Supabase (1)

**What Jasmin does today:**
- Responds to DMs and @mentions, delegates specialist work to Otto
- Monitors public channels for blockers/urgent items (15-min batch analysis)
- Generates morning (9am) and EOD (7pm) briefings automatically
- Manages Notion tasks (query, create, update, comment)
- Searches meeting transcripts and summaries
- Sends messages as Daniel (with approval) and reads his DMs
- Remembers preferences and patterns across sessions

**Infrastructure:**
- Runs on DigitalOcean droplet (139.59.144.194, fra1) via systemd
- Deploy: `./scripts/deploy.sh` (git pull → pnpm install → build → restart)
- Socket Mode (one active connection — droplet is primary)
- Supabase (DAI) for persistence, Supabase (BMAD) for client data
- All agents on `claude-opus-4-6`, briefings/monitoring analysis on Sonnet

---

## Completed Phases

### Phase 1: Agent Definition ✅
Agent YAML, manifest entry, persona/instructions, router keywords.

### Phase 2: Tool-Use Runner ✅
Agentic tool-use loop in `src/agents/runner.ts`, tool registry, assistant profile.

### Phase 4: Notion Integration ✅
5 tools: query_tasks, create_task, update_task, add_task_comment, search_notion.

### Phase 5: Fireflies Integration ✅
4 tools: search_meetings, get_meeting_summary, get_meeting_transcript, list_recent_meetings. Dedup RPC, edge function cron every 6h.

### Phase 6: Channel Monitoring ✅
Keyword pre-filter → Supabase buffer → 15-min batch Claude analysis → DM Daniel on blockers/urgent. 3 tools + generate_briefing.

### Send As Daniel ✅
`send_as_daniel` and `read_dms` tools using `SLACK_USER_TOKEN` (xoxp-). Gated to assistant profile. Instructions require Daniel's explicit approval before sending.

---

## Remaining Phases

### Phase 3: Calendar & Email Integration

**Goal:** Jasmin can check Daniel's calendar, create events, read/search emails, and draft replies.
**Prerequisites:** Google OAuth credentials for Daniel's accounts (personal gmail + work adsontap.io).
**Estimate:** Medium complexity — needs OAuth token management.

#### Approach Options

**Option A: Google OAuth directly**
- Use `googleapis` npm package
- Store refresh tokens in `.env` or Supabase
- Create `src/integrations/google.ts` with calendar + gmail clients
- Pro: Full control, no external deps. Con: OAuth flow setup, token refresh logic.

**Option B: `gogcli` or similar CLI wrapper**
- Shell out to a CLI tool for calendar/email
- Pro: Quick. Con: Fragile, hard to extend.

**Option C: MCP servers**
- Use existing Google Calendar / Gmail MCP servers
- Pro: Standard interface. Con: MCP overhead, may not fit agent tool pattern.

**Recommended: Option A** — direct Google OAuth. Matches the Notion integration pattern.

#### Tools to Add (7 new)
| Tool | Description |
|------|-------------|
| `list_events` | List calendar events for a date range |
| `search_events` | Search events by query across both accounts |
| `create_event` | Create calendar event (confirmation required for events with attendees) |
| `check_availability` | Check free/busy across both calendars |
| `search_emails` | Search emails by query, sender, date range |
| `read_email` | Read a specific email thread |
| `draft_email` | Create a draft email (never send directly) |

#### Key Files to Create/Modify
| File | Action |
|------|--------|
| `src/integrations/google.ts` | Create — OAuth client, token refresh, calendar + gmail APIs |
| `src/agents/tools/google-tools.ts` | Create — 7 tool implementations |
| `src/agents/tool-registry.ts` | Modify — register 7 new tools |
| `src/agents/profiles/index.ts` | Modify — add tools to assistant profile |
| `agents/jasmin/INSTRUCTIONS.md` | Modify — add calendar/email operating rules |
| `.env` / `.env.example` | Modify — add Google OAuth vars |

#### Operating Rules for Jasmin
- **Calendar**: Can view freely. Creating events with attendees requires Daniel's confirmation.
- **Email**: Can search and read freely. Never send — only create drafts for Daniel's review.
- **Default account**: work (adsontap.io). Must specify when using personal.
- **Two accounts**: personal gmail, work adsontap.io — both accessible.

---

### Phase 7: Enhanced Briefings

**Goal:** Richer briefings that include calendar, email, and cross-source intelligence.
**Prerequisites:** Phase 3 (Calendar & Email).

#### Enhancements
1. **Morning briefing additions:**
   - Today's calendar (meetings, gaps, conflicts)
   - Unread important emails (flagged, from key contacts)
   - Yesterday's unfinished tasks
   - Upcoming deadlines (next 3 days)

2. **EOD briefing additions:**
   - Tomorrow's calendar preview
   - Tasks completed today vs planned
   - Emails that still need replies

3. **Weekly briefing** (Monday morning):
   - Week ahead calendar overview
   - Open tasks by priority
   - Pending decisions/approvals
   - Key meetings this week

#### Key Files to Modify
| File | Action |
|------|--------|
| `src/scheduler/briefings.ts` | Modify — add calendar/email data gathering, weekly briefing |
| `src/scheduler/setup.ts` | Modify — register weekly briefing job |

---

### Phase 8: Approval Flow (Slack Interactive)

**Goal:** Jasmin proposes actions via Slack buttons, Daniel approves/rejects from his phone.
**Prerequisites:** Phase 3 (for email/calendar actions), send_as_daniel (done).

#### Use Cases
- "Should I reply to Nina's email with X?" → [Approve] [Edit] [Skip]
- "Franzi asked about the meeting — want me to tell her you're running late?" → [Send] [Edit]
- "You have a conflict tomorrow at 2pm — reschedule standup to 3pm?" → [Reschedule] [Keep]
- "3 overdue tasks — want me to update priorities?" → [Review] [Snooze]

#### Implementation
1. Use Slack Block Kit for interactive messages (buttons, select menus)
2. Register action listeners in `src/slack/listeners/` for button clicks
3. Store pending actions in Supabase `pending_actions` table
4. Timeout: auto-expire after 24h with reminder

#### Key Files to Create/Modify
| File | Action |
|------|--------|
| `src/slack/listeners/approval-actions.ts` | Create — handle approve/reject/edit button clicks |
| `src/agents/tools/approval-tools.ts` | Create — propose_action tool for Jasmin |
| `src/agents/tool-registry.ts` | Modify — register propose_action |
| `agents/jasmin/INSTRUCTIONS.md` | Modify — when to propose vs just do |

---

### Phase 9: Self-Learning

**Goal:** Jasmin learns Daniel's preferences, patterns, and communication style over time.
**Prerequisites:** Phases 3, 8.

#### Learning Signals
- **Approval patterns**: Which proposals Daniel approves/rejects/edits → learn thresholds
- **Briefing feedback**: Reactions to briefing items → learn what matters
- **Communication style**: How Daniel edits drafts → learn his writing voice
- **Scheduling patterns**: Meeting preferences, buffer times, busy hours
- **Priority signals**: What Daniel acts on immediately vs defers

#### Implementation
- Track approval/rejection rates per action type
- Store learned preferences in memory (via `remember` tool)
- Periodic synthesis: weekly job that reviews recent interactions and extracts patterns
- Confidence tiers: tentative → confirmed → strong (based on consistency)

#### Key Files to Create/Modify
| File | Action |
|------|--------|
| `src/learning/jasmin-learning.ts` | Create — preference extraction and synthesis |
| `src/scheduler/learning-jobs.ts` | Modify — add Jasmin preference synthesis job |
| `agents/jasmin/INSTRUCTIONS.md` | Modify — reference learned preferences |

---

## Architecture Reference

### Key Files
```
agents/jasmin/
├── agent.yaml              # Agent config (model, profile, sub_agents)
├── PERSONA.md              # Personality and communication style
└── INSTRUCTIONS.md         # Operating rules, security, team knowledge

src/agents/
├── runner.ts               # Agentic tool-use loop (shared by all agents)
├── registry.ts             # Loads agent definitions from YAML/MD
├── tool-registry.ts        # All tool definitions + executors
├── profiles/index.ts       # Tool profiles (assistant = Jasmin's toolset)
└── tools/
    ├── memory-tools.ts     # recall, remember, search_memories
    ├── agent-tools.ts      # ask_agent (delegation)
    ├── slack-tools.ts      # post_message, reply_in_thread, send_as_daniel, read_dms
    ├── fireflies-tools.ts  # 4 meeting tools
    ├── notion-tools.ts     # 5 task/search tools
    └── monitoring-tools.ts # channel insights, mentions, history, briefing

src/monitoring/
├── buffer.ts               # Supabase message buffer for channel monitoring
└── analyzer.ts             # Claude-powered batch analysis (15-min loop)

src/scheduler/
├── briefings.ts            # Morning/EOD briefing generation
├── learning-jobs.ts        # Scheduled learning loops
├── setup.ts                # Job registration
└── index.ts                # Scheduler infrastructure

src/slack/listeners/
├── channel-monitor.ts      # Public channel message listener + keyword pre-filter
└── insight-actions.ts      # Slack interactive button handlers (methodology approval)
```

### Supabase Tables (DAI)
| Table | Used For |
|-------|----------|
| `channel_monitor` | Buffered Slack messages with keywords + priority |
| `monitoring_insights` | Analysis results (blockers, urgent, notable) |
| `briefings` | Persisted morning/EOD briefings |
| `meetings` | Fireflies meeting metadata |
| `meeting_sentences` | Transcript sentences with speaker + timestamps |
| `learnings` | Long-term memory entries |
| `observations` | Session observations |

### Environment Variables
| Var | Required | Description |
|-----|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot token (xoxb-) |
| `SLACK_APP_TOKEN` | Yes | App token (xapp-) for Socket Mode |
| `SLACK_USER_TOKEN` | No | User OAuth token (xoxp-) for send_as_daniel/read_dms |
| `SLACK_OWNER_USER_ID` | Yes | Daniel's Slack user ID |
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `DAI_SUPABASE_URL` | Yes | DAI Supabase project URL |
| `DAI_SUPABASE_SERVICE_KEY` | Yes | DAI Supabase service role key |
| `NOTION_TOKEN` | No | Notion integration token |
| `NOTION_KANBAN_DB_ID` | No | Notion kanban database ID |

### Deployment
- **Droplet**: 139.59.144.194 (fra1, 4 vCPU, 8GB RAM, Ubuntu 24.04)
- **Service**: systemd (`/etc/systemd/system/dai.service`)
- **Deploy**: `./scripts/deploy.sh` — git pull, pnpm install, build, restart
- **Logs**: `ssh root@139.59.144.194 "journalctl -u dai -f"`
- **Node**: v22, pnpm via corepack

### Adding a New Tool (pattern)
1. Implement function in `src/agents/tools/<domain>-tools.ts`
2. Register in `src/agents/tool-registry.ts` with definition + execute
3. Add tool name to profile in `src/agents/profiles/index.ts`
4. Document in `agents/jasmin/INSTRUCTIONS.md` if it has operating rules
5. Build, deploy: `./scripts/deploy.sh`

---

## Session Strategy

One bounded deliverable per session:
1. Read this spec
2. Read the referenced files for your target phase
3. Implement
4. Build (`pnpm build`), verify no errors
5. Deploy (`./scripts/deploy.sh`) and verify in logs
6. Update this spec's "Current State" section
