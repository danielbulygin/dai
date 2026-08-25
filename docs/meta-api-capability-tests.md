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
   silently on any busy pixel.
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
