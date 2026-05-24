# Piper — Evolution Plan

The long-term goal: Piper handles the project management of AOT's entire production pipeline as a proactive partner — surfacing what's slipping before it slips, helping things move, identifying trends. The team handles exceptions; Piper handles the routine 80%.

This document is the roadmap. Each phase is shippable on its own and unlocks the next. Update as phases complete; mark items ✅ as they ship.

---

## Operating principles

These hold across every phase:

- **Notion captures intent; corroborate against the system that holds truth.** Meta for upload + spend, Frame.io for review status, Drive for asset delivery, Supabase for historical state.
- **fact / count / guess** confidence labels on every specific claim.
- **Surface conflicts rather than picking winners.** When two sources disagree, name the disagreement; the team decides.
- **Read-then-write graduation.** Each new capability lands read-only first; writes come later with confirmation gates and audit logs.
- **Every action is logged.** From Phase 1.5 onward, every tool call, write, and DM writes a row to `piper_actions` so any decision can be traced back to its data.
- **Cadence is the headline output.** Piper exists to keep the pipeline moving at contracted rate. Cadence reads, gap detection, and capacity vs throughput are the primary value the team gets.

---

## Phase 0 — Read-only diagnostic ✅ shipped 2026-05-23/24

Piper reads Notion (tasks + ad sets), reconciles upload tasks against Meta, identifies bottleneck owners, produces per-client digests, applies fact/count/guess labels. Terminal-only.

**What works today:**

- `query_aot_tasks` + `query_aot_adsets` with auto-pagination, 90-day freshness default, four terminal-status exclusions (Done/Cancelled/Complete/Archived Task)
- `check_ads_in_meta` for the Notion ↔ Meta reconciliation
- Upload reconciliation workflow (stale vs real backlog)
- Cadence snapshot per client (stage counts only — no history)
- Confidence labels, self-verification rules, data-quality patterns surfaced
- Terminal mode via `pnpm chat:piper`

**Known constraints (motivate the next phases):**

- No historical data → no trend or forecast
- No DM capability → no proactive nudges
- No write access → can only observe
- dai runner's 60K-char-per-tool cap clips large tool results

---

## Phase 1 — Data layer (engine for everything downstream)

**Goal:** give Piper a queryable, historical mirror of pipeline state so cadence, trends, forecasts, and aggregations become possible.

**Key builds:**

- Nightly Supabase sync of AOT Tasks DB + Ad Sets DB. Each row gets a snapshot timestamp. Mirror in `aot_tasks_snapshots` + `aot_adsets_snapshots`. Run on droplet systemd timer per [[feedback_pipelines_on_droplet]].
- Stored per-client cadence targets in `client_cadence_targets`: ad-sets-per-week, concept-queue-target, max-cycle-time-days.
- Aggregation tools: `count_aot_tasks(filters)`, `count_aot_adsets(filters)` — answer "how many" without paginating row payloads. Sidesteps the runtime char cap entirely.
- Data-quality probes (nightly job tracking null ad_set_ids, archived-but-active leaks, past-delivery-but-non-Done, etc.). Trended over time; alerts when metrics drift >2x week-over-week.
- Raise / re-route the dai runner's 60K-char-per-tool cap so big aggregations don't clip.
- Query routing: `query_aot_tasks` / `query_aot_adsets` can optionally pull from Supabase (snapshot newer than X minutes) instead of hitting Notion, falling back to Notion for fresh-data demands.

**Dependencies:** none. This is the foundation.
**Effort:** ~2-3 sessions.

---

## Phase 1.5 — Action logging (foundational, audit-anything)

**Goal:** every action Piper takes is traceable. Reads + writes + DMs + auto-digests. Builds the substrate that makes Phase 5 writes safe.

**Key builds:**

- `piper_actions` Supabase table:
  ```
  id, timestamp, agent_id, session_id
  action_type      'tool_call' | 'write' | 'dm' | 'digest_posted'
  tool_name
  initiator        Slack user id, or 'cron'
  params           jsonb (full input)
  result_summary   short string
  target_system    'notion' | 'meta' | 'slack' | 'frameio'
  target_id        the entity touched
  before_state     jsonb (writes only)
  after_state      jsonb (writes only)
  reverse_action   jsonb ("how to undo this")
  status           'success' | 'failed' | 'partial'
  duration_ms
  error
  ```
- Wrapping middleware in dai's tool-registry: every tool execution writes a row before + after the call.
- `inspect_piper_actions(window, filter)` tool so Piper can audit himself ("everything I did for Press London this week") and humans can ask "why did you say X".
- Retention policy: 1 year default, configurable.

**Dependencies:** Phase 1 (Supabase exists).
**Effort:** ~half a session.
**Why now and not in Phase 5:** retrofitting audit logs across multiple phases of tool work is painful. Doing it once at the foundation means every later phase is safe by default.

---

## Phase 2 — Cadence & forecast intelligence

**Goal:** Piper produces real cadence reads using the Phase 1 data layer. This is the headline capability the team is asking for.

**Key capabilities:**

- "Audibene tracking 60% of target over 4 weeks" with the math shown
- Concept-queue gap detection: "queue is 7 vs target 12, gap = 5; to recover by month-end you need 8 new concepts in the next 14 days"
- Forecast: "at current velocity you'll run out of in-flight ad sets by 2026-06-18"
- Drift alerts when something changes pattern (week-over-week or month-over-month)
- Stage-lag averages per client: "Audibene briefs take 5 days, editing 8, QC 2 — end-to-end cycle time ~15 days"
- Capacity vs throughput per person from history: "Franzi's sustainable rate is ~5 tasks/day; current queue is 168 active; she's ~5 weeks behind"
- Risk scoring on each in-flight delivery (factoring stage-lag history + current state + remaining work)
- Recovery scenarios: "to hit Friday on ADBNx3884, brief sign-off needs to land tomorrow latest"

**Dependencies:** Phase 1 (historical data required).
**Effort:** ~1-2 sessions. Pure logic on top of Phase 1.

---

## Phase 3 — Slack proactive observer

**Goal:** Piper moves from "answers when asked in terminal" to "tells you what matters in Slack."

**Key builds:**

- Slack app registration + `#piper` channel
- `PIPER_BOT_TOKEN` + `PIPER_APP_TOKEN` in `dai/.env`; terminal stubs removed from `chat-piper.ts`
- Morning digest auto-posted (cadence gaps + at-risk deliveries + real overdue work, NOT zombies)
- Weekly per-client digest drafted in each client's Slack channel; AM reviews then sends
- Pattern alerts: "Brain.fm cadence dropped 40% this month, here's what changed"
- Full digest format from METHODOLOGY.md, posted as Slack Block Kit

**Dependencies:** Phase 2 (the digest needs cadence intelligence to be worth posting). Phase 1.5 (auto-posts get logged).
**Effort:** ~1 session (excluding token registration).

---

## Phase 4 — Proactive intervention (DM follow-ups)

**Goal:** Piper helps things move, not just observe.

**Key builds:**

- Notion → Slack identity bridge in `team_identities` Supabase table, seeded by email match across `notion.users.list` + Slack `users.list`
- `piper_followups` Supabase table tracking question → reply state:
  ```
  id, task_id, ad_set_code
  asked_slack_user, asked_at
  channel_id, thread_ts
  question, status ('asked'|'answered'|'expired'|'cancelled')
  response, response_at
  controller_slack_user
  ```
- `dm_followup(ad_set_code, question, controller)` tool — opens DM, posts question, inserts pending row, returns thread_ts
- `summarize_open_followups()` tool — rolls outstanding follow-ups into the next digest with their replies (or "no reply yet")
- Inbound message handler in `dai/src/slack/dedicated-bots.ts`: recognizes replies on `piper_followups` threads and updates the row
- Controller config: `PIPER_CONTROLLER_USER_ID` env var as v1; `piper_controllers` table for v2
- Auto-drafted Slack messages for the AM to send when DMs don't get replies ("Mikel didn't reply — want me to draft a check-in?")
- Reassignment + escalation suggestions when someone's clearly overloaded

**Dependencies:** Phase 3 (Slack already wired).
**Effort:** ~2-3 sessions. The follow-up registry has real state semantics; deserves its own arc.

---

## Phase 5 — Write capabilities (closing the loop)

**Goal:** Piper closes the loop, reversibly.

**Key builds:**

- Notion write tools: `update_aot_task(task_id, fields)` (status, due_date, assignee), `create_aot_task(ad_set_id, name, ...)` (when stage transitions imply downstream work)
- Confirmation gates by default — every write asks before executing (unless the user has explicitly authorized recurring writes for that pattern)
- `before_state` + `reverse_action` captured to `piper_actions` for every write (already wired from Phase 1.5)
- The upload-reconciliation "stale bucket" becomes one-click close
- Stage-transition automation (auto-create QC task when editing marks complete, etc.) — initially behind a feature flag per client
- `undo_last_action(action_id)` tool for human-triggered rollback using the `reverse_action` jsonb

**Dependencies:** Phase 1.5 (every write must be logged), Phase 4 (Slack confirmation surface).
**Effort:** ~2 sessions. Highest-stakes phase — careful guardrails non-negotiable.

---

## Phase 6 — Learning & pattern recognition

**Goal:** Piper improves over time without us reprogramming him.

**Key builds:**

- `piper_known_corrections` table: team corrections persist across sessions
  - "PLx2964 is a zombie, ignore it" → never re-surface
  - "Daniel doesn't own Rehook briefs — it's Franziska" → reassignment in subsequent reads
- `remember_correction()` and `apply_corrections()` tools — every digest filters against active corrections; footer notes "N rows dropped per team corrections"
- Recurring failure mode detection: cross-client / cross-person / cross-stage patterns from the snapshot history
- Confidence calibration tracking: was that `[guess]` right? Compare to eventual outcome via Phase 1 history. Surfaces "Piper's guesses for category X have been right 87% of the time, for category Y 42% — trust accordingly."
- Per-person preference memory ("Mikel responds to terse pings, not paragraphs")
- Per-client pattern memory ("Press London approvals consistently take 3 days, not the 1 we plan for")
- Cross-quarter trend reports

**Dependencies:** All prior phases. This is the polish layer.
**Effort:** ~2-3 sessions, mostly post-launch tuning.

---

## What's deliberately NOT in the plan

- **Brief intake quality checks** — overlaps with Maya/Ada's upstream work. Surface bad briefs via slip data; don't gate at intake.
- **Client-facing reports** — Cora already does brief-comms with clients. Piper stays internal.
- **Replacing the Pipeline Tool product** — Piper operates inside today's infrastructure (Notion + Slack + Drive + Frame.io); Pipeline Tool is a separate destination. See [[project_pipeline_tool]].

---

## Phase dependency graph

```
Phase 0 ✅ ──→ Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4 ──→ Phase 5 ──→ Phase 6
                  │
                  └────────→ Phase 1.5 (parallel; blocks Phase 5)
```

---

## Progress tracking

| Phase | Status | Shipped | Notes |
|---|---|---|---|
| Phase 0 | ✅ | 2026-05-23/24 | v1.0 → v1.3 + accuracy work |
| Phase 1 | ✅ | 2026-05-24 | Mirror live (10K tasks + 2.3K ad sets), nightly + webhook + droplet timers + cadence_targets + data-quality probes |
| Phase 1.5 | ✅ | 2026-05-24 | piper_actions audit log + inspect_piper_actions; middleware on every dai tool call |
| Phase 2 v1 | ✅ | 2026-05-24 | get_cadence_read + get_cadence_read_all — tracking-vs-target + concept-queue gap. ADBN verified at 131% of 4/week target. |
| Phase 2 v2 | — | — | Gated on snapshot history (~2 wks): forecast, stage-lag, drift alerts, capacity, risk scoring |
| Phase 3 | — | — | First Slack surface |
| Phase 4 | — | — | DM follow-ups |
| Phase 5 | — | — | Highest-stakes |
| Phase 6 | — | — | Polish + learning |

---

## Open strategic questions

1. **Smart-first vs visible-first** (Phase 2 before Phase 3, or Phase 3 first). Default: smart-first. Half-baked Slack agents lose trust fast and getting it back is hard.
2. **Sync on droplet or Vercel?** Existing AOT scheduled pipelines run on droplet systemd timers per [[feedback_pipelines_on_droplet]]. Default droplet.
3. **One all-clients morning digest, or one per client?** Probably one all-clients post in `#piper` + per-client drilldowns on request. Confirm during Phase 3 build.
4. **Phase 5 auto-write aggressiveness.** Default: every write asks for confirmation. Some routine ones (auto-close tasks confirmed-stale via Meta reconciliation) could become standing authorizations once trust is established.
5. **Where does Piper's controller live?** Mikel? Dan? Per-client different controller? Configure via `piper_controllers` table in Phase 4.

---

Last updated: 2026-05-24
Maintained by: Dan + Piper-build sessions
