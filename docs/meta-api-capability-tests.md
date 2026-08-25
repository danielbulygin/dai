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
