# Phase 9: Jasmin Self-Learning — Implementation Prompt

## Context

You are working on **DAI**, a multi-agent Slack system. Read `CLAUDE.md` at the repo root for the full stack and conventions.

Jasmin is Daniel's personal assistant agent. She has 28 tools (`assistant` profile), generates briefings, manages calendar/email/tasks, and runs as her own dedicated Slack bot. She already has memory tools (`remember`, `recall`, `search_memories`) that store learnings in the `learnings` Supabase table — but she only remembers things Daniel explicitly asks her to.

**Master spec**: `docs/specs/jasmin-evolution.md` — read the full file for architecture reference, key files, and Supabase tables.

## Goal

Make Jasmin learn Daniel's preferences, patterns, and communication style automatically over time — without him having to tell her things twice. She should get measurably better at anticipating what Daniel wants.

## Learning Signals

Jasmin can learn from 5 signal types, no approval buttons required:

### 1. Conversation Patterns
- What Daniel asks for repeatedly → learn to proactively offer it
- How he phrases requests → learn his vocabulary and intent patterns
- What he ignores or dismisses → learn what's noise
- What he asks follow-up questions about → learn what needs more depth

### 2. Briefing Reactions
- Slack reactions on briefing messages (already captured by the reaction listener)
- `:+1:` / `:white_check_mark:` → useful item, boost similar content
- `:-1:` / `:x:` → irrelevant, deprioritize similar content
- No reaction → neutral, don't over-index

### 3. Email Draft Edits
- When Jasmin drafts an email and Daniel edits it before sending, the edits reveal his writing style
- Track: tone, length, level of formality, signature preferences, common phrases
- This requires comparing Jasmin's draft with what Daniel actually sent (future signal — note this as a TODO for when we add sent-email tracking)

### 4. Scheduling Preferences
- Preferred meeting times, buffer preferences, which calendars for which events
- How Daniel responds to availability checks (which slots he picks)
- Meeting length preferences per type (1:1 vs team vs external)

### 5. Delegation Patterns
- What Daniel delegates vs handles himself
- Which agents he asks Jasmin to use vs goes directly to
- Task assignment patterns (who gets what type of work)

## What to Build

### 1. Preference Extraction Job — `src/learning/jasmin-learning.ts` (new file)

Create a scheduled job that runs daily and extracts preferences from Jasmin's recent interactions.

#### `extractPreferencesFromSessions()`
- Query recent Jasmin sessions from the last 24 hours:
  ```sql
  SELECT s.id, s.created_at FROM sessions s
  WHERE s.agent_id = 'jasmin' AND s.created_at > NOW() - INTERVAL '24 hours'
  ```
- For each session, get all messages:
  ```sql
  SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at
  ```
- Send the conversation to Claude (use `claude-haiku-4-5-20251001` for cost efficiency) with a prompt that extracts:
  - **Explicit preferences**: Things Daniel directly states ("I prefer...", "always...", "never...", "don't...")
  - **Implicit preferences**: Patterns in how he interacts (brief vs detailed requests, time-of-day patterns, topic priorities)
  - **Corrections**: When Daniel corrects Jasmin or asks her to redo something differently
  - **Delegation patterns**: What he delegates, to whom, and how he frames it

- Output format per extraction:
  ```typescript
  interface ExtractedPreference {
    category: 'communication' | 'scheduling' | 'delegation' | 'briefing' | 'workflow' | 'personal';
    content: string;           // The preference in natural language
    confidence: number;        // 0.3 for first observation, increases with repetition
    source: 'conversation' | 'briefing_reaction' | 'correction' | 'repetition';
    evidence: string;          // Quote or summary of what triggered this
  }
  ```

- Before saving, check for existing similar preferences using `findDuplicateLearning()`:
  - If a matching preference exists with the same meaning → increment confidence (cap at 0.95)
  - If a contradicting preference exists → update it with the newer preference, reset confidence to 0.5
  - If it's new → save with confidence 0.3

- Save to `learnings` table with `agent_id: 'jasmin'` and category prefixed with `preference_` (e.g., `preference_communication`, `preference_scheduling`).

#### `extractPreferencesFromBriefingReactions()`
- Query recent reactions on briefing messages:
  ```sql
  SELECT f.* FROM feedback f
  WHERE f.agent_id = 'jasmin'
  AND f.created_at > NOW() - INTERVAL '24 hours'
  ```
- Map reactions to signals:
  - Positive (`:+1:`, `:white_check_mark:`, `:heart:`, `:fire:`) → "Daniel found this useful"
  - Negative (`:-1:`, `:x:`, `:no_entry:`) → "Daniel didn't want this"
- Send to Haiku with the original briefing message + reaction to extract what specifically Daniel liked/disliked
- Save as learnings with category `preference_briefing`

### 2. Weekly Preference Synthesis — `synthesizeJasminPreferences()`

A weekly job (Sundays 10am) that consolidates and deduplicates Jasmin's accumulated preferences.

- Fetch all Jasmin preferences: `getLearnings('jasmin')` filtered to `preference_*` categories
- Send to Claude (Sonnet — this is a synthesis task) with instructions to:
  1. **Merge duplicates**: Combine preferences that say the same thing differently
  2. **Resolve conflicts**: If two preferences contradict, keep the more recent or higher-confidence one
  3. **Promote confirmed patterns**: If a preference has been observed 3+ times (confidence >= 0.7), mark it as confirmed
  4. **Expire stale preferences**: If a preference hasn't been reinforced in 30 days and has low confidence (< 0.5), flag for removal
  5. **Generate a "Jasmin's Understanding of Daniel" summary**: A concise natural-language summary of what Jasmin knows about Daniel's preferences

- Update the learnings table: delete merged duplicates, update confidence scores, remove expired ones
- Save the summary as a special learning with category `preference_summary`

### 3. Context Injection — Modify `src/agents/hooks/session-lifecycle.ts`

The existing `onSessionStart` already injects top learnings into the system prompt. Enhance it for Jasmin:

- When `agentId === 'jasmin'`, also fetch the `preference_summary` learning and inject it as a `<daniels_preferences>` block
- Fetch top 15 (not just default 10) preferences for Jasmin since she has more context to work with
- The preferences should appear before the top_learnings block so Jasmin sees them first

### 4. Register Scheduled Jobs — Modify `src/scheduler/learning-jobs.ts`

Add two new jobs:

```typescript
// Jasmin daily preference extraction (11pm Berlin — end of day, after all interactions)
registerJob('jasmin-preference-extraction', '0 23 * * *', 'Europe/Berlin', async () => {
  const { extractPreferencesFromSessions, extractPreferencesFromBriefingReactions } =
    await import('../learning/jasmin-learning.js');
  await extractPreferencesFromSessions();
  await extractPreferencesFromBriefingReactions();
});

// Jasmin weekly preference synthesis (Sundays 10am Berlin)
registerJob('jasmin-preference-synthesis', '0 10 * * 0', 'Europe/Berlin', async () => {
  const { synthesizeJasminPreferences } = await import('../learning/jasmin-learning.js');
  await synthesizeJasminPreferences();
});
```

### 5. Confidence Tiers

Define clear confidence tiers for preference learnings:

| Tier | Confidence Range | Meaning | Behavior |
|------|-----------------|---------|----------|
| Tentative | 0.3 – 0.49 | Observed once | Jasmin may mention it but doesn't act on it |
| Emerging | 0.5 – 0.69 | Observed 2-3 times | Jasmin starts applying it |
| Confirmed | 0.7 – 0.89 | Consistent pattern | Jasmin applies it by default |
| Strong | 0.9 – 0.95 | Deeply ingrained | Jasmin treats it as a given, only mentions if asked |

The extraction prompt should output confidence based on signal strength:
- Explicit statement ("I always want...") → start at 0.6
- Correction ("No, do it this way") → start at 0.5
- Implicit pattern (observed behavior) → start at 0.3
- Repeated observation → increment by 0.15 each time (cap at 0.95)

### 6. Update Jasmin's Instructions — `agents/jasmin/INSTRUCTIONS.md`

Add a section about self-learning:

```markdown
## Learning & Preferences

You learn Daniel's preferences over time from your interactions. Your learnings are injected
into your context at the start of each conversation as `<daniels_preferences>`.

- **Apply confirmed preferences** (confidence >= 0.7) by default without asking
- **Mention emerging preferences** when relevant: "Last time you preferred X — should I do that again?"
- **Never assume** from a single observation — wait for repetition before changing behavior
- When Daniel corrects you, acknowledge it and note that you'll remember for next time
```

### 7. Update Jasmin's SOUL.md — `agents/jasmin/SOUL.md`

Add to the "How You Handle Things" section:

```markdown
- **Learning**: You get better over time. You notice patterns in what Daniel likes, how he works, and what matters to him. You don't need to be told twice — but you also don't jump to conclusions from a single interaction. When you're applying a learned preference, you do it naturally, not by announcing "Based on my learnings..."
```

## What NOT to Change

- The `learnings` table schema — it already supports everything we need (agent_id, category, content, confidence, client_code)
- The existing `remember` / `recall` / `search_memories` tools — they still work for explicit memory, this is an automatic layer on top
- Ada's learning system (`src/learning/feedback.js`, `decision-evaluator.js`, etc.) — completely separate
- The runner or tool execution — no changes needed

## Key Files Reference

| File | Action |
|------|--------|
| `src/learning/jasmin-learning.ts` | **Create** — preference extraction + synthesis |
| `src/scheduler/learning-jobs.ts` | **Modify** — register 2 new jobs |
| `src/agents/hooks/session-lifecycle.ts` | **Modify** — enhanced context injection for Jasmin |
| `agents/jasmin/INSTRUCTIONS.md` | **Modify** — add learning section |
| `agents/jasmin/SOUL.md` | **Modify** — add learning note |
| `docs/specs/jasmin-evolution.md` | **Update** — mark Phase 9 done |
| `src/memory/learnings.ts` | **Reference only** — existing functions: `addLearning`, `getLearnings`, `findDuplicateLearning`, `updateLearningConfidence`, `getTopLearnings` |
| `src/memory/messages.ts` | **Reference only** — `getMessages(sessionId)` for reading conversation history |
| `src/memory/sessions.ts` | **Reference only** — session queries |

## Implementation Order

1. Create `src/learning/jasmin-learning.ts` with `extractPreferencesFromSessions()` and `extractPreferencesFromBriefingReactions()`
2. Add `synthesizeJasminPreferences()` to the same file
3. Register both jobs in `src/scheduler/learning-jobs.ts`
4. Modify `src/agents/hooks/session-lifecycle.ts` for enhanced Jasmin context
5. Update `agents/jasmin/INSTRUCTIONS.md` and `agents/jasmin/SOUL.md`
6. Update `docs/specs/jasmin-evolution.md`

## Error Handling

- All extraction functions wrapped in try/catch — a single session failing should not block others
- Haiku calls should have a timeout (60s) and retry once on failure
- If synthesis fails, preferences still accumulate — synthesis is cleanup, not critical path
- Log at `info` level for extraction counts, `debug` for individual preferences, `error` for failures

## Verification

1. `pnpm build` — zero errors
2. Boot without errors
3. Manual test: have a conversation with Jasmin, then call `extractPreferencesFromSessions()` directly and verify preferences appear in the `learnings` table with `agent_id = 'jasmin'` and `category LIKE 'preference_%'`
4. Verify context injection: start a new Jasmin session after preferences exist and check logs for `learningsCount` > 0
5. Deploy: `./scripts/deploy.sh`
6. After 24 hours: check that the nightly job ran and extracted preferences from the day's conversations
