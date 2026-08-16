# The Tinkers audit bridge

The cold-audit rail (`POST /api/audit/trigger` → `runColdAudit` → `runMagicAudit`)
only speaks the legacy data model: `ada_leads` for the goal, `meta_connections`
for the token, `magic_audits` for the report. The Tinkers monorepo is a separate
application with a separate database, and it triggers this endpoint with its
**organization id** in `userId`. Nothing in our tables resolves that id, so
before this bridge those audits died at token resolution.

The bridge adds a second path through the same machinery: context comes FROM
Tinkers, results go BACK to Tinkers, and we never touch their database.

**The agency path is untouched.** A body without the bridge marker runs the
exact code it ran before — same idempotency reads, same `runColdAudit`, same
`ada_leads.audit_token` write. `tests/audit-trigger.test.ts` asserts the
branching in both directions.

## The trigger

```jsonc
// legacy (agency / ada_leads lead) — unchanged
{ "userId": "<auth user uuid>" }

// bridged (Tinkers monorepo org)
{ "userId": "<organizationId>", "auditId": "<tinkers audit row id>", "source": "tinkers" }
```

Both carry `X-Ada-Secret: $AUDIT_TRIGGER_SECRET` and both answer `202 {"status":"accepted"}`
with the audit running async. The bridge path is taken only when BOTH
`source === "tinkers"` and a non-empty `auditId` are present; half a marker
falls back to the legacy path. With `TINKERS_BASE_URL` or
`TINKERS_AUDIT_SEAM_SECRET` unset, the bridge path answers `503` (the same
shape `AUDIT_TRIGGER_SECRET` uses when it is unset) and starts nothing.

The bridge path deliberately SKIPS the legacy idempotency reads — they cannot
resolve a monorepo org. Tinkers answers idempotency itself (see
`already_complete` below).

## The seam

Every request we send Tinkers is signed with HMAC-SHA256 over the exact JSON
bytes of the body, hex digest, in the `x-tinkers-signature-256` header, under
`TINKERS_AUDIT_SEAM_SECRET`.

**`POST {TINKERS_BASE_URL}/api/webhooks/audit-context`** — `{ organizationId }`

```jsonc
{ "ok": true, "auditId": "...", "adAccountId": "act_…", "accessToken": "…",
  "currency": "EUR", "accountName": "…", "goalMetric": "roas", "goalValue": 2.5,
  "grossMarginPct": 45 }
// or
{ "ok": false, "reason": "unknown_org" | "no_connection" | "already_complete" | "not_configured" }
```

`already_complete` is a clean no-op: we log it and return without running.
Every other `ok: false` is fail-loud — no context means no audit, and the reason
is logged at error level. Nothing runs blind.

**`POST {TINKERS_BASE_URL}/api/webhooks/audit-complete`** — contract v1.1: EVERY
content payload is a partial, including the last one, and the audit is sealed by
a separate message that carries no content at all.

```jsonc
// content — sent repeatedly as the report fills in, the accumulated row last
{ "auditId": "…", "partial": true, "sections": …, "scorecard": …, "leadInsights": …,
  "recognition": …, "workLog": …, "costUsd": 1.23 }

// completion — Tinkers flips the row COMPLETE and emails from what it stored
{ "auditId": "…", "finalize": true }
```

Splitting completion off the last content payload keeps the finalize call small
enough to clear any body cap no matter how fat the report got.

Our columns are snake_case (`lead_insights`, `work_log`, `cost_usd`); the
contract is camelCase. `toTinkersPatch` does that mapping and drops the keys
that are ours alone (`status`, `updated_at`). The answer is
`{ received, recorded }`; `recorded: false` is logged as a warning and never
retried — Tinkers' own sweep is the fallback. On the finalize message that
warning is worded deliberately ("audit may already be sealed — the sweep
reconciles if not") and must never read as a failed audit: Tinkers only accepts
content writes while the audit is RUNNING, so a finalize that timed out on our
side but landed on theirs answers `recorded: false` on the retry — with the
audit complete and its customer email already sent.

Reports are chained rather than fired in parallel, so a stale `sections`
snapshot cannot land after a newer one and undo visible progress on the page
that polls them.

`toTinkersPatch` runs on EVERY payload — there is one call site (`reportInOrder`
in `runBridgedColdAudit`), and it is the only caller of `reportAuditUpdate` in
the codebase. This matters more than it looks: Tinkers' zod strips unknown keys,
so a top-level snake_case key arrives as no content at all — `recorded: false`,
sections silently lost, HTTP 200. The mirrored patches are our raw column names
by construction, so the mapping cannot be skipped for the progressive ones
"because they're just partials". Pinned by `runBridgedColdAudit reporting >
maps EVERY payload, not just the last one`, which asserts no key on any posted
body contains an underscore, and by `AuditOptions.onRowUpdate > hands over our
raw snake_case column names — the shapes the bridge must map`, which fails if
the orchestrator ever emits a column shape the bridge does not know.

A patch whose mapped form holds no content key (`sections`, `scorecard`,
`leadInsights`, `recognition`, `workLog`) is not posted at all — the
orchestrator's closing `{ status, cost_usd }` write maps to `costUsd` alone,
which Tinkers stores nothing from, so posting it would earn a `recorded: false`
warning on every healthy run.

### A failed audit is never finalized

When the run ends with section errors (the orchestrator writes `status: 'error'`
to its own row), the content still goes over as a partial — the evidence is
worth having — but the finalize message is NOT sent. Tinkers' row stays RUNNING,
so it does not flip COMPLETE, does not mail "I found something", and does not
burn the one-ever email latch on a broken report; their 24h fallback rail
handles the lead honestly instead. Both branches are tested.

### One audit per org at a time

`runBridgedColdAudit` keeps an in-process set of organization ids with a run in
flight. A second trigger for an org already running logs and returns
`{ status: 'skipped', reason: 'already_running' }` without starting anything.
The trigger is fire-and-forget from Tinkers and their idempotency answer cannot
see an audit that started a second ago, so without this a double-click costs two
Graph pulls, two LLM bills, and two streams of partials interleaving into one
row. The guard is per-process (a restart clears it) — it is a burst guard, not a
distributed lock; `already_complete` from the context endpoint remains the
durable half of idempotency.

### The token

`accessToken` is in memory for the run only. It is never persisted, never
echoed back, and never logged. Errors bound for a log are reduced to their
message and then scrubbed by `redactSecrets` (access_token query params, `EAA…`
tokens, any 40+ character secret-shaped run) — because an upstream error
message can quote the credential it choked on.

The same scrub runs over the string values INSIDE every payload
(`redactPayload`, applied in `toTinkersPatch`), not just over log lines. Section
errors carry raw `err.message` from whatever threw, every Graph URL in the
orchestrator interpolates the access token inline, and this content is rendered
on a public `/audit/<token>` page — so one future `throw new Error(url)` in a
section runner would publish a live customer token to a shareable page. Nothing
leaks today; the scrub sits where the token is known so that class of bug cannot
reach the wire even once. Two tests pin it: the token cannot reach a log line,
and a section error embedding a token arrives at the wire redacted.

## What changed inside the audit

`magic-audit.ts` gained ONE optional field:

```ts
onRowUpdate?: (patch: Record<string, unknown>, meta: { final: boolean }) => void | Promise<void>;
```

Every `updateRow` patch is mirrored to it (fire-and-forget, fail-soft), plus
one final call with the accumulated row state — that last one IS awaited, so a
bridged run reports completion before it resolves. A caller that passes nothing
gets the old behavior exactly; `tests/magic-audit-row-mirror.test.ts` runs the
same audit with and without the option and asserts the sequence of writes to
`magic_audits` is identical.

Nothing else in `magic-audit.ts` was touched: no section, no prompt, no cost
meter, no ordering.

## Env

| Var | Purpose |
|---|---|
| `TINKERS_BASE_URL` | Tinkers app origin (e.g. `https://gettinkers.com`) |
| `TINKERS_AUDIT_SEAM_SECRET` | Shared secret we sign seam requests with; must match the Tinkers Vercel env |

Both optional in `src/env.ts` — unset simply means the bridge path is closed
(503), exactly like `AUDIT_TRIGGER_SECRET`.

## Deploy

Set both vars in `/root/dai/.env` first (the bridge path 503s without them,
which is the honest state, not an outage), then on the droplet:

```bash
cd /root/dai && git pull --ff-only && pnpm build && systemctl restart dai
```

The restart bounces all agents (Ada/Piper/Maya/Jasmin) as usual.

## Evals

CLAUDE.md's mandatory Ada eval loop covers changes to Ada's behavior —
`agents/ada/**`, `src/agents/runner.ts`, `src/agents/registry.ts`, tool
definitions/profiles, model/thinking config. This change touches none of them:
it is a new trigger branch, a new seam module, and one optional callback in the
audit orchestrator. No prompt, tool, or model configuration moves, so the
golden-question evals are not triggered. (Considered and ruled out
deliberately — not skipped.)
