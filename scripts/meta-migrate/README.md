# Meta cross-account migration toolkit

Scripts and findings from porting a client's Meta ad structure from one ad
account to another within the same Business Manager.

**Test run (2026-05-14):** PRESS London (`act_1814118775391116`) →
Naturally Better Nutrition (`act_978593421213192`), BM "PRESS"
(`183495899666330`), filter = entities with spend in last 90 days.

Final result: **9/9 campaigns, 45/45 adsets, 85/156 ads (54%)**. The 71
unmigrated ads are all catalog-template Advantage+ Creative ads — see "Hard
limits" below.

## TL;DR for future-Claude (or future-me)

If you need to do this again:

1. Update the account IDs at the top of each script (`OLD_ACCOUNT`,
   `NEW_ACCOUNT`, in `audit.ts` / `recreate.ts` / `share-audiences.ts`).
2. Make sure `META_ADS_ACCESS_TOKEN` in `.env` has scopes
   `ads_management`, `ads_read`, `business_management`.
3. `pnpm tsx --env-file=.env scripts/meta-migrate/audit.ts`
   — produces `manifest.json` (read-only).
4. `pnpm tsx --env-file=.env scripts/meta-migrate/share-audiences.ts -- --apply`
   — shares each referenced custom audience with the new account.
5. `pnpm tsx --env-file=.env scripts/meta-migrate/recreate.ts -- --dry-run`
   — preview without executing.
6. `pnpm tsx --env-file=.env scripts/meta-migrate/recreate.ts -- --campaign <id>`
   — run for one campaign first as a smoke test.
7. `pnpm tsx --env-file=.env scripts/meta-migrate/recreate.ts`
   — full run. Resumable via `--resume`.
8. `pnpm tsx --env-file=.env scripts/meta-migrate/generate-handoff.ts`
   — produces `needs-manual.csv` and `summary.md`.

All created entities land **paused**. Activation is manual.

## What works

- **Same BM is essential.** Page, pixel, Instagram actor are referenced
  by ID and resolve cross-account because they're shared at the BM level.
- **`object_story_id` reuse.** When source ad has `effective_object_story_id`,
  POSTing `/act_NEW/adcreatives` with just `object_story_id=<page>_<post>`
  works and preserves social proof. **~54% of ads land via this single path.**
- **`POST /<audience_id>/adaccounts adaccounts=["<NEW_ACCOUNT_NUMERIC>"]`**
  shares a custom audience with the new account without copying it.
- **Campaign/adset structural recreation.** `POST /act_NEW/campaigns` and
  `/act_NEW/adsets` with field-for-field payloads from the source manifest
  works reliably.

## What does NOT work (do not try again)

- **`POST /<campaign_id>/copies` with `parent_id=act_NEW`.** Meta accepts the
  parameter silently but ignores it; copies land back in the source account.
  Verify the response's `account_id`, don't just trust the absence of `_error`.
- **`/copies` with `deep_copy=true` sync.** Hard 3-entity limit per call.
- **`POST /act_NEW/async_batch_requests` containing `/copies` ops.** Returns
  "relative_url field invalid" — async batch is for bulk *creation*
  endpoints, not for `/copies`.
- **Cross-account image hash claim via `POST /act_NEW/adimages copy_from={hash, source_account_id}`.**
  Returns "Invalid parameter" with no useful detail. Multiple shape variants
  tried; never landed on a working one. Cross-account image work likely
  needs Business Asset Library or re-upload.
- **`asset_feed_spec` rebuild for catalog-template page posts.** The source
  page post itself is a "dynamic creative" carrier. No combination of
  payload fields lets `/adcreatives` accept it without a `product_set_id`,
  even when the source ad doesn't have one.

## Hard limits

**Catalog-template Advantage+ Creative ads** (creative `object_type: SHARE`
with `{{product.name}}` etc. in the creative name) cannot be migrated via
the Marketing API to a different ad account in the same BM. Meta returns:

```
error_user_title: "Dynamic creative missing product set ID"
error_user_msg:   "Attempted to create a dynamic creative with no product set ID."
```

The constraint is on the page post, not on our request. We tried:
- `object_story_id` only
- `object_story_id` + `degrees_of_freedom_spec` (source)
- `object_story_id` + `degrees_of_freedom_spec` (all OPT_OUT)
- `asset_feed_spec` rebuild

All fail identically. These ads need:
- Manual rebuild in Ads Manager UI (~3-5 min each), OR
- Meta's UI-only "Duplicate to another ad account" feature (which handles
  dynamic creatives more leniently than the API)

The 71 catalog-template ads in the test run are listed in
`needs-manual.csv`, each row with: source ad name, destination adset ID
(already created), Facebook post URL, source creative ID.

## Other gotchas worth remembering

- **Token mismatch.** `.env` had two Meta tokens: `META_ACCESS_TOKEN` (broken)
  and `META_ADS_ACCESS_TOKEN` (working). The agent runner code references
  the broken one. Migration scripts use the working one.
- **`pages_manage_ads` was declined.** Did not cause issues — `ads_management`
  covered it.
- **End-time validation.** If source adset has a past `end_time`, recreate
  fails with "End date is in the past". Strip past `end_time` and `start_time`.
- **Instagram Explore placement validation.** Meta added a rule
  (late 2025/2026): if `instagram_positions` includes `explore_home`, it
  must also include `explore`. Source adsets predate this rule and need
  patching during recreation.
- **Audience accessibility is two-layer.** A token with BM scope can READ
  any audience but cannot USE it in adset targeting unless the audience is
  shared with the specific destination account. The audit script's
  "accessible" check (read-based) gave a false-positive.
- **Adlabel IDs in `asset_feed_spec.asset_customization_rules` are
  account-scoped.** Carrying them over to a new-account creative may cause
  validation issues even if image hashes are claimed.

## Files

| File | Purpose |
|---|---|
| `audit.ts` | Read-only: snapshots source structure + asset accessibility into `manifest.json` |
| `share-audiences.ts` | Lists and (with `--apply`) shares custom audiences with new account |
| `recreate.ts` | Main migration script. Structural creation, resumable via `id-map.json` |
| `generate-handoff.ts` | Produces `needs-manual.csv` + `summary.md` for handoff |
| `smoke-test.ts` | Historical: probed cross-account `/copies` (DEAD END — kept for reference) |
| `async-probe.ts` | Historical: probed `async_batch_requests` (DEAD END) |
| `probe-creative.ts` | Historical: tested 4 creative-spec shapes for catalog ads (all failed) |
| `migrate.ts` | Historical: shallow `/copies` per entity (DEAD END — `parent_id` ignored) |
| `manifest.json` | Source snapshot from `audit.ts` |
| `id-map.json` | `source_id → new_id` for everything migrated; supports `--resume` |
| `errors.log` | Append-only error stream from `recreate.ts` |
| `needs-manual.csv` | Handoff: ads that need manual rebuild, with destination IDs |
| `summary.md` | Handoff: high-level migration report |
| `image-hash-map.json` | Tracks image hashes attempted in `--apply` (claim never worked) |

## Don'ts

- Don't delete entities in any ad account without explicit user permission,
  even your own test residue. (See
  `~/.claude/projects/-Users-danielbulygin-dev-dai/memory/feedback_never_delete_ad_account_state.md`.)
- Don't trust an API response's absence of `_error` as success. Check the
  `account_id` on returned objects to verify they actually landed where you
  asked.
- Don't try to migrate catalog-template AC ads via API. Time-sink with no
  payoff. List them for manual handling and move on.
