# Meta API capability tests

The standing rule (Daniel, 2026-08-23): **every new Ada capability ships with a
regression case here AND a case in the web-parity golden set**
(`tests/eval/golden-questions-web.json`). No check, no capability.

A case records what we PROBED, not what the docs promise: the exact shape, the
exact refusal, and the trap that cost time. A capability whose case says
"should work" has not been tested.

> The older corpus (cases 1-28) lives on the unmerged
> `ada-action-log-and-account-guard` branch, and case 29 sits beside this file in
> `docs/meta-api-capability-case-29.md`. They fold in here when that branch lands.

---

## Case 30 — Pixel event counts (`get_pixel_event_stats`)

**Probed:** 2026-08-25, against BFM (`act_1726935217614830`, a live high-traffic
pixel) and AOTUS (`act_1570076840279279`, the practice account).

**Shape:**
`GET /act_<id>/adspixels?fields=id,name,last_fired_time`, then per pixel
`GET /<pixel_id>/stats?aggregation=event&start_time=<unix>&end_time=<unix>`.
Counts are summed per event `value` across the returned buckets.

**Results:**

| What | Finding |
|---|---|
| Bucket granularity | **HOURLY**, not daily. 7 days = 168 rows, ~800KB. |
| Window ceiling | 10 days answers; **14 days is refused** with `Please reduce the amount of data you're asking for`. The tool therefore walks any window in <=7-day chunks and sums. |
| Distinct-event cap | **100 per bucket.** A pixel with a longer tail loses its rarest events. BFM hits it, so the tool returns the caveat rather than presenting a silent undercount. |
| Practice account | Both AOTUS pixels answer `(#100) Permission Denied` on `/stats` while the pixel LIST reads fine. |

**Regression checks:**

1. A 28-day request fires FOUR `/stats` calls, none spanning more than 7 days.
   One call for 28 days means the chunking was removed and the read now fails
   silently on any busy pixel. With an `event` named it fires FIVE: the extra
   one is the last-7-days read behind `last7dShare`. It cannot be saved by
   reusing the final chunk — that chunk only lines up with the last week when
   the window is a multiple of seven days.
2. A refused pixel returns `readable: false` with Meta's message and NO
   `total_events`. **`Permission Denied` must never render as a zero** — "this
   pixel fired nothing" and "I could not look" are different facts, and the
   practice account is the live fixture that proves the difference.
3. An account whose pixel LIST is empty says so as a fact about the account; an
   account whose pixel list FAILS to read says the list could not be read. "No
   pixel" is the most alarming sentence available about an account's tracking
   and is never guessed.
4. Loose-name resolution: `event: "qualified subscriber"` resolves to
   `QualifiedSubscription` on BFM (41,887 fires in 7 days against 9,279
   `Purchase`). **This is the case the tool exists for and it fails on
   case-insensitive substring matching alone** — "subscriber" is not a substring
   of "subscription". The matcher's stem rung (first 6 characters of each word)
   is what carries it; a rewrite that drops the stem rung reintroduces the
   original bug.
5. `qualified lead` does NOT resolve to `QualifiedSubscription` — sharing one
   word is not a match.
6. With an `event` named, the result carries `funnelCheck`: that event's count
   beside `Purchase`, `StartTrial` and `CompleteRegistration`, a one-word
   verdict, and `last7dShare`. `higher_than_purchase` is the case it exists for.
   The live answer on 2026-08-25 read `QualifiedSubscription` at 58,828 against
   35,018 `Purchase` over 28 days, 42k of it in the last 7, and called it "good
   signal density". A qualified-subscriber event is a SUBSET of purchases, so
   out-firing them means it is over-counting or is defined differently from its
   name — the client confirmed the event was mis-defined. A verdict that stays
   `ok` on such a pixel is a regression, and so is `no_purchase_event` handed
   over as though the count were fine on its own. AOTUS cannot exercise this
   (both its pixels refuse `/stats`); BFM is the probe account for it.

**Trap:** the shared `graphGet` helper defaults to a 500-row cap. A 7-day read
is 168 rows, but a 28-day read as ONE call would be 672 and would silently
truncate even if Meta answered it. The chunking and the raised `maxRows` are
both load-bearing.

---

## Case 31 — Custom conversions (`get_custom_conversions`)

**Probed:** 2026-08-25, BFM and AOTUS.

**Shape:**
`GET /act_<id>/customconversions?fields=id,name,custom_event_type,rule,is_archived,pixel&limit=100`

**Results:** reads cleanly on both accounts, including AOTUS, whose pixel
`/stats` is denied — so on a locked-down account this is often the ONLY readable
answer to "what is that event?". BFM returns 4, AOTUS returns 1
(`Qualified Lead`, `custom_event_type: LEAD`).

`rule` is a JSON blob naming the raw event and the URL test behind the
conversion, e.g.
`{"and":[{"event":{"eq":"Lead"}},{"or":[{"URL":{"i_contains":"thank-q"}}]}]}`.
It is truncated to ~160 characters for reading. `pixel` expands to `{id}` only.

**Regression checks:**

1. `custom_event_type` survives — it is what says a conversion named
   "First Trial Started" is really a `START_TRIAL`.
2. A rule longer than 160 characters comes back truncated with a trailing
   ellipsis, never dropped.
3. An empty list says the read SUCCEEDED and the account has none; a failed read
   says the list could not be read. Same rule as the pixel list.

---

## Case 32 — Tenancy on both reads

Both tools are in `SCOPED_BMAD_TOOLS`, so `executeTool` overwrites
`input.clientCode` from the verified scope before the executor runs, and both
executors re-derive it from `context.clientScope` as well.

**Regression check** (`tests/pixel-events-scope.test.ts`, and re-verified live on
2026-08-25): calling either tool with `clientCode: "LA"` inside a BFM-scoped
context reads `act_1726935217614830` with BFM's token. A model-supplied client
code must never reach Graph. These are open account-level reads; without the
forcing, a customer chat could read another tenant's Events Manager.

---

## Case 33 — "May I execute here?" as a frame (`/chat`, scoped)

**Probed:** 2026-08-25, BFM (`act_1726935217614830`), read-only against the live
`clients` + `guard_settings` rows.

**Why:** a founder flipped his account to human-in-the-loop and asked Ada "does
that work for you now?". She was honest and had to guess: "if that toggle
changed something on your end, I'm not seeing a new verb on my side." She could
read the rails; she had no shape to say the answer in that the portal could act
on. The scoped `/chat` stream now opens with one frame, before any text or tool
frame:

```
event: capability
data: {"type":"capability","can_execute":false,"reason":"mode_read_only","verbs":[]}
```

`reason` is one of `ok | mode_read_only | mode_stopped | no_lane | unknown`, and
`verbs` is `["pause","resume","set_daily_budget"]` (the tinkers `ActionCommand`
vocabulary) or empty. The internal unscoped `/chat` and `/assist` never emit it:
the console has real write tools and no switch to offer.

**Shape read:** `clients.ad_account_id` + `clients.allowed_campaign_ids`, then
`guard_settings(mode, stopped_at)` for that account — the same two rails
`handleExecuteAction` enforces, read once and mapped once, so the sentence Ada
speaks and the frame the portal reads cannot disagree.

**Shape accepted** (added the same day, once the two systems were found
disagreeing — see the trap below). The scoped `/chat` body may carry an optional
control block, derived server-side by the portal from the org's selected ad
account:

```json
{ "control": { "mode": "read_only" | "hitl" | "autonomous", "stopped": true } }
```

Both keys are required and typed: `mode` one of exactly those three strings,
`stopped` a real boolean. Anything else — absent, null, an array, a string, one
key missing, `"stopped": "yes"`, `"mode": "HITL"` — is thrown out WHOLE and the
turn takes the old path. A half-formed block is not a partial truth to mix with
the guard row, it is a caller we do not understand, and our own read is the
fail-closed one.

**Who owns which switch (2026-08-25):** the PORTAL is the source of truth for
the account's control mode and its STOP; the droplet stays the source of truth
for the fence. So a control block overrides `guard_settings.mode` and
`stopped_at`, in BOTH directions, and overrides nothing else. `allowed_campaign_ids`
is still read here, which is why a portal saying `hitl` over an empty fence
lands on `no_lane` rather than promising a verb with nowhere to land. A
disagreement between the two sources logs one debug line carrying the client
code and the two reason words, and nothing else — never a value from the body.

**Mapping, in precedence order** (NOT the order the rails are read):

| Rail state | `reason` | Who can change it |
|---|---|---|
| a read failed, or no client / ad account | `unknown` | nobody yet — say the setting did not come back |
| `stopped_at` set | `mode_stopped` | the customer, on the Today page |
| no `guard_settings` row, or mode not hitl/autonomous | `mode_read_only` | the customer, on the switch the chat draws |
| hitl/autonomous, `allowed_campaign_ids` empty or null | `no_lane` | us — it is a setup step, never their switch |
| hitl/autonomous with a fence | `ok` | — the three verbs are live |

Where a control block arrived, rows two and three read `control.stopped` and
`control.mode` in place of the guard row; row four and row five read the fence
exactly as before, and row one is unchanged (a failed client read leaves no
fence to consult, so a portal mode cannot rescue it).

STOP outranks the mode row it contradicts (it is the newest thing a human said);
mode outranks the fence, so a read-only account is never shown a setup problem
in place of its own switch.

**Result on BFM, with no control block:**
`{"can_execute":false,"reason":"mode_read_only","verbs":[]}`.

**Result on BFM, once the portal sends `{"mode":"hitl","stopped":false}`:**
`{"can_execute":false,"reason":"no_lane","verbs":[]}`, and the debug line
`control sources disagree for BFM: portal no_lane, guard row mode_read_only`.

**The trap, and why the control block exists.** BFM has **no `guard_settings`
row at all** and `allowed_campaign_ids` is **null**, while the founder had just
set the account's **tinkers** `controlMode` to HITL. The two systems keep
separate switches: tinkers `controlMode` lives in the tinkers Postgres and
nothing there writes this Supabase table (grep: `guard_settings` appears nowhere
in tinkers). Read from here alone the frame said `mode_read_only`, the portal
would have drawn the switch, and flipping it would have changed a row this read
never looks at. Hence the split above: the customer-facing switch travels with
the request and wins.

It also moves BFM's honest answer from `mode_read_only` to `no_lane`, which
points at a different person — their mode is fine, our lane is not built. The
fence is null, and `no_lane` is a lane only we can open. Ada says so in those
terms, with no date attached.

**Regression checks** (`tests/capability-frame.test.ts`, pure mapping with the
two reads mocked):

1. Every row of the table above, each reason reached on its own.
2. Precedence: STOP over an open hitl+fence AND over read_only; mode over an
   empty fence; a failed read over rails already in hand.
3. `verbs` is empty and `can_execute` false for every reason but `ok`, and the
   `ok` list is exactly the three — a verb named here is a promise.
4. The guard row is looked up by the account the CLIENT row named, never by
   anything that arrived beside the code.
5. `parseControlInput` rejects fourteen malformed shapes whole, and the mapping
   with a rejected or absent block is byte-identical to the old path.
6. The portal override runs BOTH ways: it opens a lane a stale read-only guard
   row would have shut, and shuts one a stale hitl row would have opened; its
   `stopped` outranks its own mode; and an empty fence still answers `no_lane`
   however open the portal says the mode is.
7. The disagreement line matches a strict whole-line pattern: the client code
   and two words from our own closed vocabulary, no account id, nothing echoed.

---

## Case 34 — The founder's safety rules on the customer door (`/chat`, scoped)

**Probed:** 2026-08-25, by reading the scoped prompt itself. No Meta call: this
is a case about what Ada is TOLD, and the reason it belongs in this corpus is
that every rule in it protects something the Graph API will happily let her
destroy.

**Shape:** one section, `SAFETY_RULES_SECTION` in
`scripts/ada-console-assist.ts`, pushed into `buildScopedChatPrompt` between the
capability sentence and the proposal rail. Six rules, one line each:

| Rule | What it protects |
|---|---|
| Attribution is chosen once, at ad set creation, and cannot be changed after | `attribution_spec` is immutable on a created ad set. Ada saying otherwise sends a customer looking for a control Meta does not expose. |
| Never edit an ad set or ad that has already spent; copy it instead | An edit to a spent object throws away the learning that spend paid for. Pausing, and adding new ads to an existing set, stay allowed. |
| Never delete anything, ever; everything new lands PAUSED | A delete is unrecoverable and there is no delete verb anywhere in the write lane. Disposables stay PAUSED. |
| CBO or ABO, bid strategy, optimization goal are the customer's decisions | These are structural and effectively one-way after spend. A quiet default is a decision taken on someone else's behalf. |
| fb.me, m.me, wa.me, facebook.com, instagram.com are Meta surfaces | They look like dead pages to any check that expects a website, and "pause the ad, its page is dead" is the wrong advice with high confidence attached. |
| The readiness facts before any proposal: pixel, conversion event, destination URL, Page and Instagram identity | A proposal built without them is a recommendation with an unnamed dependency. |

**The trap.** The rules are stated on the SCOPED door only. The internal console
prompt frames a teammate holding a real write surface and different rails; the
same six lines there would read as a description of what internal Ada may do,
which is not what they say.

**Regression checks** (`tests/scoped-prompt-safety.test.ts`, pure — the prompt
builders are exported and called directly, no mocks):

1. Exactly six rule lines, and each rule asserted on its load-bearing phrase
   rather than its whole sentence: a reword passes, a dropped rule does not.
2. Attribution carries the DEFAULT as well as the prohibition. "State it
   explicitly" with no default only moves the guess one step later.
3. The section is in the scoped prompt and absent from the internal one.
4. It sits BEFORE the proposal rail. The rules constrain what may be proposed,
   so a prompt that reads the rail first has them arriving as an afterthought to
   a card already drafted.
5. No em-dash anywhere in the section. The rest of the prompt is guidance Ada
   paraphrases; these are sentences she is told to state as written, so they are
   held to the customer-copy rule.

**Golden cases:** `web-attribution-immutable` and `web-onplatform-destination`
in `tests/eval/golden-questions-web.json`. Both grade on AOTUS without needing
live spend.

---

## Case 35 — Web search on the customer door (`WebSearch` / `WebFetch`, scoped)

**Probed:** 2026-08-25, by reading the three gates rather than by trying a
search.

**The finding, which is not what the build note assumed.** Web search was
**already reachable** for client-scoped Ada before this change. Three things
decide it and only one of them is the profile:

| Gate | State before | Effect |
|---|---|---|
| `guard.ts` `BUILTIN_READS` | `WebSearch`, `WebFetch` both present | allow |
| `query()` options in `runAgentSDK.ts` | no `allowedTools` / `disallowedTools` passed | every built-in reachable |
| `client_media_buyer` profile | did NOT list them | **no effect** |

The profile drives `getToolsForProfile`, which walks the dai tool REGISTRY and
**silently skips any name it does not hold** (`tool-registry.ts`). No built-in
has a registry entry, which is why `readonly`/`standard`/`coding`/`full` can all
list `Read`/`Grep`/`WebSearch` harmlessly. So the profile list is a statement of
INTENT for built-ins, never the gate. Reading "the profile does not list it" as
"it is off" is the trap, and it is the kind of wrong that only shows up as a
surprise line item.

**What actually changed:** the profile now names both (intent, matching the
sibling profiles), a one-line prompt rule says what they are FOR, and
`CLIENT_WEB_SEARCH_ENABLED` in `runAgentSDK.ts` is the one named place to turn
them off for the customer door.

**Config flag:** none needed. The SDK requires no per-tool configuration for
either. **Cost:** a web search is billed per call on top of the tokens it
returns, which is the whole reason the switch is named rather than implicit,
and it lands against the scoped chat's `maxBudgetUsd`. The constant defaults ON
per the 2026-08-25 mandate; per-plan locking is the portal's job, not this
constant's.

**The prompt rule, in the "Look before you claim" section** (where facts get
their provenance): public facts only, a competitor's own site, a Meta policy or
help page, a platform change; never anything about this customer's account,
spend or results, which come from the tools and nowhere else; and name the
source.

**Regression checks:**

1. `tests/scoped-prompt-safety.test.ts` holds the rule to naming BOTH tools, to
   the public-facts confinement, to the ban on pointing them at the customer's
   own account, and to the source requirement.
2. Golden case `web-public-fact-source`: a Meta-policy question must be answered
   from a NAMED public source, not from recall, and must not drag the account's
   own data into a question that is not about the account. An answer that
   declines to look and answers from memory is wrong even when the substance is
   right, because nothing in it is checkable.
3. `CLIENT_WEB_SEARCH_ENABLED = false` must add `disallowedTools` for the scoped
   door only. It is a customer-door switch: internal Ada's search is not on it.

---

## Case 36 — The house playbooks as skills (`ada-playbook-*`)

**Probed:** 2026-08-25. The three playbooks in `docs/playbooks/` are now three
Agent-SDK skills in `skills/ada-playbook-*/SKILL.md`: `ada-playbook-ecom`,
`ada-playbook-leadgen`, `ada-playbook-nina-deltas`. Each is frontmatter, a
four-line "How Ada applies this" head, then the playbook text verbatim.

**Shape.** Skills are NOT controlled by tool profiles. Two things decide which
ones Ada can load:

- `cwd` in `runAgentSDK.ts` — `ADA_SDK_SKILLS_CWD`, defaulting to
  `/root/ada-sdk-spike/skills-root`, whose `.claude/skills/` holds the six
  existing skills as **symlinks into `/root/bmad/.claude/skills/`**.
- `skills:` in the `query()` options — `DEFAULT_ADA_SKILLS`, a **context
  filter**, not a sandbox. Per the SDK types, a name the cwd has never
  discovered is simply not offered; it is not an error. That is what makes it
  safe to land the three names ahead of the symlinks.

`/root/dai/.claude/` is gitignored, so the skills live at `skills/` in the repo
root, where they are tracked.

**The sync step the serving checkout needs** (not run here — the serving
checkout is off limits to the builder, and this changes what Ada can load):

```sh
ln -s /root/dai/skills/ada-playbook-ecom        /root/ada-sdk-spike/skills-root/.claude/skills/ada-playbook-ecom
ln -s /root/dai/skills/ada-playbook-leadgen     /root/ada-sdk-spike/skills-root/.claude/skills/ada-playbook-leadgen
ln -s /root/dai/skills/ada-playbook-nina-deltas /root/ada-sdk-spike/skills-root/.claude/skills/ada-playbook-nina-deltas
```

Until those exist the three names are inert, so a golden question added today
would grade their absence. That case is deliberately NOT in
`golden-questions-web.json` yet; it goes in with the sync.

**Two things to decide before the symlinks go in.**

1. **Size.** 120KB / 86KB / 44KB. A skill body loads whole on invoke, so
   `ada-playbook-ecom` is roughly 30k input tokens against a scoped chat capped
   at `maxBudgetUsd` 1.5-2. If that proves too heavy, the fix is a short
   SKILL.md that points at a bundled reference file per section, not a trimmed
   playbook.
2. **Third-party names.** The playbooks quote other agency clients by name with
   their numbers (Audibene, Brain.fm, Teethlovers, Nine Pine, Strayz, Slumber,
   forpeople, Laori). `DEFAULT_ADA_SKILLS` is shared by BOTH doors, so admitting
   them admits them to the customer door too. Rule 3 of the head is the control
   today — never name another account, another client or their numbers to a
   customer, the method travels but the accounts it came from do not — and a
   prompt rule is a soft control, not a wall. The hard version is a separate
   client-scoped skill list, which is a real change to the seam and is a
   founders' call, not a builder's.

---

## Case 37 — Pause and resume at any level (`pause_campaign`, `resume_*`)

**Probed:** 2026-08-25 against AOTUS (`act_1570076840279279`), reads and dry
runs only. Probe: `scripts/_b11-practice-dryrun.mts`.

**Shape.** `POST /<object_id>` with `status=ACTIVE|PAUSED`, then a read-back.
The read BEFORE the write is what had to change: which fields you may ask for
depends on the level, and the level now comes from the verb rather than from
"is this a pause_ad".

| Level | Fields the rail asks for |
|---|---|
| ad | `id,name,status,effective_status,campaign_id,account_id` |
| adset | the same plus `daily_budget` |
| campaign | `id,name,status,effective_status,daily_budget,account_id` — **no `campaign_id`** |

**Results:**

| What | Finding |
|---|---|
| Ad-set-shaped read of a campaign id | `(#100) Tried accessing nonexisting field (campaign_id)`. A hard OAuthException, not a missing field. Every campaign-level verb went through that read, so `pause_campaign` could not have worked even on the day it was added to `EXEC_TYPES`. |
| Campaign-shaped read | Answers with status, effective_status, daily_budget, account_id. |
| `resume_campaign` inside the fence | dry run: `would resume campaign "AoT // New CBO // Scaling"`. |
| `resume_campaign` outside the fence | refused: `campaign fence: <id> is not in AOTUS's allowed campaigns [...]`. Live, against the real client row. |
| `pause_campaign` on a campaign already paused | `{ok: true, applied: false, note: "already paused"}`. |
| `resume_ad_set` inside a fenced campaign | dry run: would resume. |

**Regression checks:**

1. A campaign-level verb never asks for `campaign_id` — not in the pre-read and
   not in the read-back. The read-back is the worse of the two: it turns a write
   that SUCCEEDED into a read that throws, so the customer is told the resume
   failed while the money is already running.
2. A resume outside the fence is refused before any POST. The campaign it is
   compared against comes from Meta's answer about the object, never from the
   intent — the rail reads the object to learn its campaign and only then
   compares. `tests/execute-action-resume.test.ts` pins this at both levels.
3. Resume is gated by the same three rails as pause — `guard_settings.mode`
   with no `stopped_at`, the account gate, the campaign fence — and a shut mode
   refuses before Meta is read at all.
4. The reverse recorded for a resume is a PAUSE. An action log whose reverse
   says `ACTIVE` for a resume undoes nothing.
5. `already active` / `already paused` are `applied: false`, never a write.

**Not probed:** an actual resume. Nothing has ever reached `/execute-action`
from the monorepo, and the first live write belongs on a fresh approval rather
than on a probe.

**No golden question yet.** None of this is reachable from chat until tinkers
sends the droplet's wire shape; that half is on `fix/execution-seam-intent-shape`
and is unmerged. The question goes in with the first real dispatch.

---

## Case 38 — Creating a campaign, validated and never created

**Probed:** 2026-08-25 against AOTUS. Probe: `scripts/_b13-practice-dryrun.mts`.

**Shape:**

```
POST /act_<id>/campaigns
  name, objective, status=PAUSED, buying_type=AUCTION,
  special_ad_categories=[], bid_strategy, daily_budget=<cents>,
  execution_options=["validate_only"]
```

**Results:**

| What | Finding |
|---|---|
| The validate_only answer | `{"success": true}` for `OUTCOME_SALES`, PAUSED, CBO $50/day, `LOWEST_COST_WITHOUT_CAP`. No id comes back, because nothing was made. |
| Campaign count | 13 before, 13 after. `validate_only` on `/campaigns` genuinely does not create — unlike `/copies` (case 15a), which is the trap this confirms is verb-specific. |
| The executor's own dry run | `would_apply` on the same intent: write mode, budget ceiling and the fence bootstrap all passed. |
| Budget ceiling | AOTUS has `clients.max_daily_budget_usd` NULL, so the $100 default applies and B13's real $500 would be refused by our own rail before Meta saw it. **Brain.fm needs its own `max_daily_budget_usd` above 500**, and tinkers' `ADA_MAX_DAILY_BUDGET` is unset in production, which refuses every budget change today. |
| Fence bootstrap | `create_campaign` is the ONE verb exempt from the empty-fence refusal, because it is the only way an empty fence ever becomes non-empty. |

**Regression checks:**

1. The validate_only call happens BEFORE the real create, every time, and the
   dry run stops between the two. A dry run that reaches the second call has
   lost the whole point of being a dry run.
2. Creates are PAUSED-only, and a budget over the ceiling is refused before
   Meta is asked anything.
3. Growing `clients.allowed_campaign_ids` with the new id is a STEP. PostgREST
   reports a failed update by returning an error rather than by throwing, so
   the update is read back, and a fence that did not grow fails the action
   while naming the campaign id that does exist. A campaign nobody can copy
   into, reported as a success, is the failure this replaces.
4. The read-back carries `bid_strategy`. Adding a campaign budget makes Meta
   silently set `LOWEST_COST_WITH_BID_CAP`, and a bid strategy nobody chose is
   invisible unless it is asked for by name.
5. `objective` still falls back to `OUTCOME_LEADS` when the intent omits it.
   **That default is a known open item** — the B13 spec asks for a refusal
   instead — and this is the case that changes when it does.

---

## Case 39 — Copying an ad set onto a different optimization event — NOT PROBED

**Written 2026-08-25 and deliberately not run.** This is the one B13 verb that
cannot be dry-run, and the case exists to say so plainly rather than to imply a
capability nobody has checked.

**Why there is no probe.** `/copies` ignores `execution_options=["validate_only"]`
and creates a real ad set (case 15a). The only honest pre-flight is validating
an equivalent ad create against the SOURCE, which tests page permission and
lead-ads terms and says nothing at all about what the copy comes out as. There
is no read-only way to learn the answer.

**What the code does now** (`handleExecuteAction`, `duplicate_ad_set`):

1. `POST /<source_adset_id>/copies` with `campaign_id`, `status_option=PAUSED`,
   `rename_options={"rename_suffix":" // Ada copy"}`.
2. `GET /<new_adset_id>/insights?fields=spend&date_preset=maximum` — the
   lifetime-spend-zero assertion. A read that FAILS is not a zero; it refuses
   the next step.
3. `POST /<new_adset_id>` with `name`, `optimization_goal`, `promoted_object`,
   `attribution_spec`, and the optional `bid_amount`.
4. `GET /<new_adset_id>` for the read-back, carrying every field the portal
   judges.

**The open question, and it is a real one.** Step 3 assumes `attribution_spec`
can be written to an ad set that already exists. The standing rule in this house
is that `attribution_spec` is IMMUTABLE after ad set creation. If that is
literally true, rather than shorthand for "after it starts delivering", then
step 3 is refused on every copy, every copy lands `copy_not_configured` and has
to be rebuilt, and **B13's copy-based plan does not work** — the campaign would
have to be built from ad sets created with the right spec rather than copied.
The code fails honestly either way, but the plan hangs on the answer.
`optimization_goal` and `promoted_object` carry a milder version of the same
doubt: editable while there is no delivery, rejected once there is.

**The probe that settles it.** It creates a real object, so it needs sign-off:

```
1. Pick a PAUSED ad set in act_1570076840279279 with a known optimization_goal.
2. POST /<id>/copies   campaign_id=<a fenced campaign>  status_option=PAUSED
3. GET  /<new_id>?fields=<the whole object>     # the before
4. POST /<new_id>      optimization_goal=... promoted_object=... attribution_spec=...
5. GET  /<new_id>?fields=<the whole object>     # the after, diffed whole
```

Record Meta's exact refusal if step 4 is refused: the message is what says
whether it is the window, the goal, or both.

**One thing the earlier probe showed by accident.** An ad set in the practice
account is named `... – Copy — ADA COPY`. That is the old hardcoded suffix, from
a real earlier run, sitting in an account whose own convention is ` // `. It is
why the suffix is now ` // Ada copy` and why an explicit `settings.name` beats
it.

**Regression checks** (`tests/execute-action-create-and-copy.test.ts` — the copy
path is mocked, so these pin OUR behaviour, not Meta's):

1. The event, promoted object, window and name are written to the COPY. The
   source is never POSTed to.
2. The spend assertion runs before the field write, and an insights read that
   failed refuses the write instead of reading as a zero.
3. Nothing is asked about spend when there is nothing to write.
4. The rename suffix follows the account's ` // ` convention.
5. An `attribution_spec` that is only nearly right is refused before anything
   is copied.
6. The read-back carries status, campaign, `optimization_goal`,
   `promoted_object`, `attribution_spec`, `bid_strategy` and budget.

---

## Case 40 — What the portal knows (`portal_context` on the scoped `/chat` turn)

**Probed:** 2026-08-25, in this repo, against the prompt builder itself. **No
Meta call is involved, and that is the case.** This is the first thing Ada
learned by being TOLD rather than by reading: the customer's business facts,
their goal and its bands, the rules they adopted and the guard findings standing
open all live in the tinkers portal's own database, and until now none of them
reached the turn. A customer could fill in the whole Setup checklist, ask a
question a minute later, and get an answer that ignored every word of it.

**Shape.** The portal (tinkers PR #332, ADR 0079) sends an optional
`portal_context` object on every scoped `/chat` request, beside the existing
`control` object:

```json
{ "v": 1, "as_of": "2026-08-25T01:40:12.000Z",
  "account":  { "id": "…", "external_id": "act_…", "control_mode": "read_only", "stopped": false,
                "target": { "metric": "cpa", "value": 40, "set_at": "2026-08-20" },
                "bands":  { "status": "confirmed", "ecstatic": 32, "happy": 40, "nervous": 48, "kill": 80 } },
  "facts":    [{ "id": "…", "topic": "…", "fact": "…", "source": "customer" }],
  "rules":    [{ "id": "…", "rule": "…", "action": "notify", "checkable": true }],
  "findings": [{ "id": "…", "severity": "red", "headline": "…", "receipt": "…", "opened_at": "…", "status": "OPEN" }],
  "unavailable": [], "truncated": [] }
```

**Results:**

| What | Finding |
|---|---|
| The key | `portal_context`, its own. `context` stays the INTERNAL console's screen context: a scoped request carrying only `context` builds a **byte-identical** prompt to one carrying nothing, pinned against a fixture captured before the field existed. One key answering to two shapes is the bug this avoids. |
| Version gate | `v` must be the number `1`. `"1"`, `2`, and a missing `v` all parse to null and render nothing at all. |
| All-or-nothing | Mirrors `parseControlInput`. A half-formed block is not a partial truth to mix in, it is a caller we do not understand, and the fallback — saying nothing about the portal — is the safe one. |
| Absent vs empty | The whole reason the shape exists. `facts: []` renders "nothing yet", which lets Ada say *you have not told me that yet*. `facts` ABSENT plus `unavailable: ["facts"]` renders "COULD NOT READ this turn" and NO list. Collapsing the two is a fabricated receipt. |
| Ceilings | The portal caps the serialized block at 8 KB and names what it cut in `truncated`, which renders as "there are more than the ones listed". This side caps one quoted sentence at 400 characters and appends `…`. |
| Tenancy | The block is **never** a tenancy input. The signed scope claim is still the only thing that decides whose data a tool may touch. `portal_context` only decides what Ada may say she was told. |
| Which switch executes | `control` (top level) remains the authority for what may EXECUTE. `account.control_mode` and `account.stopped` in the block are the authority for what Ada may SAY about the mode. Both derive from the same single portal read, so they cannot disagree inside a turn. Flipping `resolveWriteCapability` onto the block is deliberately a later change, after blocks are confirmed arriving. |
| Staleness | The block carries `as_of` and the prompt gains one bullet asking Ada to say once, if the stamp is more than ~15 minutes old, that she is working from what the portal held a few minutes ago. That bullet is added **only when a block is present** — a staleness rule about a stamp nobody sent points at nothing. |

**Regression checks** (`tests/portal-context.test.ts`, 26 cases):

1. `parsePortalContext` returns null for absent, `null`, `{}`, an array, a
   string, a missing `v`, `v: 2`, `v: "1"`, a missing `as_of` and an empty one.
2. `facts: []` survives as `[]`; an absent `facts` stays absent (`'facts' in ctx`
   is false). These two are the feature.
3. Every section renders its ids, and an ABSENT section renders **nothing** —
   asserted on the heading word not appearing, not on the list being empty.
4. `unavailable: ["findings"]` renders the could-not-read sentence and no
   findings list; `truncated` renders the there-are-more sentence.
5. A scoped request with no `portal_context`, and one carrying only the console's
   own `context`, both produce the pre-patch prompt byte for byte. Every live
   customer was on that path when this landed.
6. A block that cannot be PARSED, and an element that cannot be RENDERED (a
   finding with no `severity`), both degrade to no block with a `console.warn`.
   A wire bug the portal owns costs an omitted block, never the turn.
7. The block never reaches the internal console prompt.

**Not verified yet, and it needs a deploy.** Nothing has served a real
`portal_context` — the running `ada-console-assist` predates this commit. The
web-parity goldens the spec names ("what is my target?", "what did you catch this
week?", "what do you know about my business?", "what rules am I running?", "can
you change something?") are therefore **deliberately not in
`tests/eval/golden-questions-web.json` yet**: `scripts/eval-ada.ts --target http`
sends only `question`, `session_id`, `client_scope` and `scope_claim`, so those
questions would be graded against a turn with no block — grading the absence of
the capability and calling it a pass. Add them together with the harness field,
after the deploy, and grade them on AOTUS.
