# Jasmin Evolution — Master Specification

> This document is the single source of truth for Jasmin's evolution. Each phase is self-contained — a fresh Claude session can read this spec + the referenced files and execute any phase independently.

## Vision

Jasmin evolves from a capable assistant into Daniel's **always-on chief of staff**: managing his calendar, triaging email, sending messages on his behalf, running morning/EOD briefings, proactively surfacing what matters, and learning his preferences over time — all running 24/7 on DigitalOcean.

## Current State (as of Feb 2026)

**What Jasmin has (28 tools, `assistant` profile):**
- Memory: recall, remember, search_memories (3)
- Delegation: ask_agent → Otto → specialists (1)
- Slack messaging: post_message, reply_in_thread, send_as_daniel, read_dms (4)
- Fireflies meetings: search, summary, transcript, list_recent (4)
- Notion tasks: query, create, update, comment, search (5)
- Channel monitoring: get_channel_insights, get_recent_mentions, get_monitoring_history (3)
- Briefings: generate_briefing — morning/EOD/weekly, persisted to Supabase (1)
- Google Calendar: list_events, search_events, create_event, check_availability (4)
- Gmail: search_emails, read_email, draft_email (3)

**What Jasmin does today:**
- Responds to DMs and @mentions, delegates specialist work to Otto
- Monitors public channels for blockers/urgent items (15-min batch analysis)
- Generates morning (9am), EOD (7pm), and weekly Monday (8am) briefings automatically
- Briefings pull from 8 sources: channel insights, mentions, Notion tasks, Fireflies meetings, calendar, emails, Slack DMs, channel messages
- Briefings are delivered via Jasmin's Slack bot identity (with DAI bot fallback)
- Manages Notion tasks (query, create, update, comment)
- Searches meeting transcripts and summaries
- Sends messages as Daniel (with approval) and reads his DMs
- Remembers preferences and patterns across sessions
- Learns Daniel's preferences automatically from conversations and briefing reactions (daily extraction + weekly synthesis)

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

### Phase 3: Calendar & Email Integration ✅
7 tools: list_events, search_events, create_event, check_availability, search_emails, read_email, draft_email. Uses `googleapis` package with OAuth2 refresh tokens. Two accounts: work (adsontap.io, default) + personal (gmail). Availability checks and event search query both accounts in parallel. Emails always draft-only — never sends directly.

### Dedicated Slack Bot ✅
Jasmin runs as a separate Slack app (own bot token + app token in Socket Mode). Daniel can DM her directly under "Apps" without mentioning her name. All DMs route straight to the `jasmin` agent — no Otto, no router. The DAI bot keyword routing still works as a secondary entry point. Key files: `src/slack/app.ts` (conditional `jasminApp`), `src/slack/listeners/jasmin-dm.ts`, env vars `JASMIN_BOT_TOKEN` + `JASMIN_APP_TOKEN`.

### Phase 7: Enhanced Briefings ✅
Upgraded briefings from channel highlight reel to chief-of-staff daily brief. Added 4 new data-gathering functions: `gatherCalendarEvents` (today/tomorrow/week, both calendars, conflict detection), `gatherImportantEmails` (unread from work+personal), `gatherSlackDMs` (user token, DM channel cache, user name resolution), `gatherSlackChannelMessages` (monitored channels from Supabase). Updated morning briefing prompt (Today's Schedule → Action Required → Tasks → Overnight Activity → Notable). Updated EOD briefing prompt (Completed Today → Still Needs Reply → Open Items → Tomorrow Preview → Wind Down). Added weekly Monday briefing (8am, `0 8 * * 1`) with week calendar, weekend catch-up, priorities, decisions needed. Briefings delivered via Jasmin bot identity with DAI bot fallback. All new sources are try/catch wrapped — failures never block the briefing. Key file: `src/scheduler/briefings.ts`.

---

## Remaining Phases

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

### Phase 9: Self-Learning ✅

**Goal:** Jasmin learns Daniel's preferences, patterns, and communication style over time.

#### What Was Built
- **Daily preference extraction** (11pm Berlin): Haiku analyzes Jasmin's conversations from the last 24h, extracts explicit/implicit preferences and corrections. Also analyzes briefing reactions (👍/👎) to learn what Daniel finds useful.
- **Weekly preference synthesis** (Sun 10am Berlin): Sonnet consolidates preferences — merges duplicates, resolves conflicts, expires stale entries, generates a "Understanding of Daniel" summary.
- **Context injection**: Jasmin sessions inject `<daniels_preferences>` block with the summary + all confirmed preferences (confidence >= 0.7). Gets top 15 learnings instead of default 5.
- **Confidence tiers**: Tentative (0.3–0.49, observe only), Emerging (0.5–0.69, start applying), Confirmed (0.7–0.89, apply by default), Strong (0.9–0.95, treat as given).
- Preferences stored in `learnings` table with `preference_*` categories, no schema changes needed.

#### 5 Learning Signals
1. **Conversation patterns**: Repeated requests, vocabulary, what Daniel ignores/follows up on
2. **Briefing reactions**: Slack reactions on briefing messages (positive/negative)
3. **Email draft edits**: (TODO — requires sent-email tracking)
4. **Scheduling preferences**: Meeting times, buffers, calendar choices
5. **Delegation patterns**: What Daniel delegates vs handles himself

#### Key Files
| File | Action |
|------|--------|
| `src/learning/jasmin-learning.ts` | Created — extractPreferencesFromSessions, extractPreferencesFromBriefingReactions, synthesizeJasminPreferences |
| `src/scheduler/learning-jobs.ts` | Modified — 2 new jobs (daily extraction, weekly synthesis) |
| `src/agents/hooks/session-lifecycle.ts` | Modified — enhanced Jasmin context injection |
| `agents/jasmin/INSTRUCTIONS.md` | Modified — learning & preferences section |
| `agents/jasmin/SOUL.md` | Modified — learning behavior note |

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
    ├── monitoring-tools.ts # channel insights, mentions, history, briefing
    └── google-tools.ts     # 4 calendar + 3 gmail tools

src/monitoring/
├── buffer.ts               # Supabase message buffer for channel monitoring
└── analyzer.ts             # Claude-powered batch analysis (15-min loop)

src/learning/
└── jasmin-learning.ts      # Jasmin preference extraction + synthesis

src/scheduler/
├── briefings.ts            # Morning/EOD/weekly briefing generation
├── learning-jobs.ts        # Scheduled learning loops (incl. Jasmin daily/weekly)
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
| `GOOGLE_CLIENT_ID` | No | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth client secret |
| `GOOGLE_REFRESH_TOKEN_WORK` | No | Refresh token for work (adsontap.io) account |
| `GOOGLE_REFRESH_TOKEN_PERSONAL` | No | Refresh token for personal (gmail) account |

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
