# Phase 7: Enhanced Briefings — Implementation Prompt

## Context

You are working on **DAI**, a multi-agent Slack system. Read `CLAUDE.md` at the repo root for the full stack and conventions.

Jasmin is Daniel's personal assistant agent. She already generates morning (9am) and EOD (7pm) briefings via a scheduled job. The current briefings pull from 4 sources: channel monitoring insights, recent @mentions, Notion tasks, and Fireflies meetings. They're useful but incomplete — they miss Daniel's calendar, emails, Slack DMs, and channel conversations.

**Master spec**: `docs/specs/jasmin-evolution.md` — read the full file for architecture reference, key files, and Supabase tables.

## Goal

Upgrade Jasmin's briefings from "channel highlight reel" to a real chief-of-staff daily brief. Add 5 new data sources and a weekly Monday briefing.

## What to Build

### 1. New Data Gathering Functions in `src/scheduler/briefings.ts`

Add these alongside the existing `gatherChannelInsights()`, `gatherRecentMentions()`, etc.:

#### `gatherCalendarEvents(type: 'today' | 'tomorrow' | 'week')`
- Use `listEvents` from `src/agents/tools/google-tools.ts`
- Query both work and personal calendars in parallel (same pattern as `searchEvents`)
- For 'today': today's events. For 'tomorrow': next day's. For 'week': next 7 days.
- Format: time, title, attendees count, location if any
- Flag conflicts (overlapping events)

#### `gatherImportantEmails(hours: number)`
- Use `searchEmails` from `src/agents/tools/google-tools.ts`
- Search for recent emails using queries like `is:unread newer_than:1d` for morning, `newer_than:12h` for EOD
- Query both work and personal accounts in parallel
- Return: subject, from, date, snippet — cap at 15 results
- Focus on unread and actionable (not newsletters)

#### `gatherSlackDMs(hours: number)`
- Use the Slack **user token** (`SLACK_USER_TOKEN` / `getUserClient()` pattern from `src/agents/tools/slack-tools.ts`) to read Daniel's recent DMs
- Steps:
  1. Call `conversations.list` with `types: 'im'` to get Daniel's DM channels (cache this list — it rarely changes)
  2. For each DM channel, call `conversations.history` with `oldest` set to `hours` ago
  3. Filter to messages FROM other people (not from Daniel, not from bots)
  4. Resolve user IDs to display names via `users.info` (cache user lookups)
  5. Cap at 20 most recent messages across all DMs
- Format: "**Name**: message text (time ago)"
- This uses the existing `SLACK_USER_TOKEN` (xoxp-) which already has `im:read` and `im:history` scopes

#### `gatherSlackChannelMessages(hours: number, channels: string[])`
- Use the Slack **bot token** or **user token** to read recent messages from key channels
- Steps:
  1. Call `conversations.history` for each channel with `oldest` set to `hours` ago
  2. Filter out bot messages and message subtypes
  3. Summarize: who said what, any action items or questions directed at Daniel
  4. Cap at 30 messages total across all channels
- The channel list should come from the existing `channel_monitor` table in Supabase (channels Daniel has opted into monitoring) — query it with `getDaiSupabase().from('channel_monitor').select('channel_id').eq('active', true)`
- Format: "#channel — **User**: message snippet"

### 2. Update Morning Briefing (`generateMorningBriefing`)

Add to the existing `Promise.all` data gathering:
- `gatherCalendarEvents('today')` — today's schedule
- `gatherImportantEmails(14)` — unread emails since last EOD (~7pm)
- `gatherSlackDMs(14)` — DMs received overnight/since last EOD
- `gatherSlackChannelMessages(14, monitoredChannels)` — channel activity since last EOD

Update the system prompt structure to:
1. **Today's Schedule** — Calendar events, conflicts, gaps
2. **Action Required** — Unreplied DMs, emails needing response, blockers from channels
3. **Tasks** — Notion in-progress and to-do items, overdue items
4. **Overnight Activity** — Key Slack messages, channel highlights, meeting follow-ups
5. **Notable** — FYI items that don't need action

The key insight: the briefing should tell Daniel **what needs his attention**, not just dump data. The Claude prompt should instruct it to prioritize actionable items and group by urgency, not by source.

### 3. Update EOD Briefing (`generateEodBriefing`)

Add:
- `gatherCalendarEvents('tomorrow')` — tomorrow's schedule preview
- `gatherImportantEmails(10)` — emails that still need replies
- `gatherSlackDMs(10)` — any unreplied DMs from today

Update the system prompt structure to:
1. **Completed Today** — What got done (from Notion)
2. **Still Needs Your Reply** — Unreplied DMs and emails
3. **Open Items** — Unresolved blockers, in-progress tasks
4. **Tomorrow Preview** — Calendar + what's coming up
5. **Wind Down** — Brief note on what can wait till Monday/tomorrow

### 4. New Weekly Briefing (`generateWeeklyBriefing`)

Create a new function for a Monday morning overview:
- `gatherCalendarEvents('week')` — full week calendar
- `gatherNotionTasks(['To Do', 'In Progress', 'Blocked'])` — all open tasks
- `gatherImportantEmails(72)` — weekend emails (Friday 5pm to Monday 9am)
- `gatherSlackDMs(72)` — weekend DMs
- `gatherSlackChannelMessages(72, monitoredChannels)` — weekend channel activity

System prompt structure:
1. **This Week's Calendar** — Day-by-day overview, key meetings
2. **Weekend Catch-up** — What happened while Daniel was off
3. **Week Priorities** — Open tasks by priority, deadlines this week
4. **Decisions Needed** — Anything pending Daniel's input

Register as a scheduled job: `0 8 * * 1` (8am Monday, before the 9am morning briefing — so Daniel gets the week overview first, then the detailed daily brief at 9am).

### 5. Register Weekly Job

In `src/scheduler/briefings.ts`, add to `registerBriefingJobs()`:
```typescript
registerJob(
  'weekly-briefing',
  '0 8 * * 1', // 8am Monday
  'Europe/Berlin',
  async () => { await generateWeeklyBriefing(); },
);
```

### 6. Briefing Delivery

All briefings should be sent via the **Jasmin bot** if available, falling back to the DAI bot. This means:
- Import `jasminApp` from `src/slack/app.ts`
- If `jasminApp` exists, use its `client` to post messages (so briefings come from Jasmin's identity, not DAI)
- Fall back to the existing `postMessage` (DAI bot) if Jasmin bot isn't configured
- Create a small helper: `getBriefingClient(): WebClient` that returns `jasminApp.client` or falls back to the DAI bot client

Emojis for each type:
- Morning: `:sunrise:`
- EOD: `:moon:`
- Weekly: `:calendar:`

## What NOT to Change

- The channel monitoring system (`src/monitoring/`) — keep it as is, just consume its data
- Agent tools — don't modify existing tools, just import and call the underlying functions
- Existing briefing persistence — keep the `persistBriefing` pattern, add 'weekly' as a type
- The `briefings` Supabase table schema — the existing `type` column is a text field, just pass 'weekly'

## Implementation Order

1. Add new data gathering functions to `src/scheduler/briefings.ts` (calendar, emails, DMs, channel messages)
2. Update `generateMorningBriefing` with new data sources + revised prompt
3. Update `generateEodBriefing` with new data sources + revised prompt
4. Add `generateWeeklyBriefing`
5. Add briefing client helper for Jasmin bot delivery
6. Register weekly job
7. Update `docs/specs/jasmin-evolution.md` — mark Phase 7 as done, update Current State

## Key Files Reference

| File | Action |
|------|--------|
| `src/scheduler/briefings.ts` | Primary file — all changes here |
| `src/scheduler/setup.ts` | Verify weekly job is picked up (should work automatically via `registerBriefingJobs`) |
| `src/agents/tools/google-tools.ts` | Import `listEvents`, `searchEmails` |
| `src/agents/tools/slack-tools.ts` | Reference for `getUserClient()` pattern, or import `readDMs` |
| `src/slack/app.ts` | Import `jasminApp` for briefing delivery |
| `src/integrations/dai-supabase.ts` | Import `getDaiSupabase` for channel_monitor query |
| `docs/specs/jasmin-evolution.md` | Update when done |

## Error Handling Pattern

Every data gathering function must be wrapped in try/catch and return `null` on failure — same pattern as existing ones. A single source failing should never block the entire briefing. Log at `debug` level (not `error`) for unavailable sources since they're optional.

## Verification

1. `pnpm build` — zero errors
2. Boot without errors (all new data sources are optional/try-catch wrapped)
3. Test manually: temporarily call `generateMorningBriefing()` and verify it includes calendar, emails, DMs, and channel messages
4. Deploy: `./scripts/deploy.sh`
5. Wait for next scheduled briefing or trigger manually to verify end-to-end
