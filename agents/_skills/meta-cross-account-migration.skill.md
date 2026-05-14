---
name: meta-cross-account-migration
description: "Port a Meta campaign/adset/ad structure from one ad account to another within the same Business Manager, via the Marketing API. Knows what works, what's a dead end, and how to scope expectations."
tags: [advertising, meta, facebook, migration, api]
---

# Meta cross-account migration skill

When a client wants to move their ad structure from one Meta ad account to
another (e.g. rebranding, account replacement), this skill captures the
playbook and the hard limits — battle-tested in PRESS London → Naturally
Better Nutrition (2026-05-14, same BM).

## Prerequisites that make this feasible

- Both ad accounts in the **same Business Manager**
- Same **page, pixel, Instagram actor** assigned to both accounts
- Same **currency** and **timezone** (otherwise budget conversion math)
- Token with `ads_management`, `ads_read`, `business_management`

If any of those are no, the migration is much harder.

## The viable API path (~50-60% of ads land cleanly)

Order matters:

1. **Audit source.** Query insights with spend filter to find in-scope
   campaigns / adsets / ads. Extract every referenced asset ID (page,
   pixel, IG actor, audiences, catalog, image hashes, video IDs, post IDs).
2. **Share custom audiences with destination account.**
   `POST /<audience_id>/adaccounts adaccounts=["<NEW_ACCOUNT_NUMERIC>"]`.
   Audiences read fine cross-account but **cannot be USED in adset
   targeting unless explicitly shared**. The read-based "accessibility"
   check is a false positive.
3. **Structural recreation** (not `/copies`):
   - `POST /act_NEW/campaigns` field-for-field
   - `POST /act_NEW/adsets` with full `targeting`, `promoted_object`,
     `attribution_spec`, etc.
   - `POST /act_NEW/adcreatives` with `object_story_id =
     <effective_object_story_id>` — reuses the existing Page post,
     preserves social proof
   - `POST /act_NEW/ads` referencing new adset + new creative
4. **Land everything paused.** Activation is the user's call.
5. **Resumable id-map.** Persist `source_id → new_id` after each create so
   partial failures can be retried with no double-creates.

## Hard limits to set expectations BEFORE starting

**Cross-account `/copies` does not work.** Meta silently ignores
`parent_id` and lands the copy back in the source account. Always verify
the response's `account_id` field, not just absence of error.

**Async batch requests do not accept `/copies` operations.** Returns
"relative_url field invalid". `async_batch_requests` is for bulk creation
endpoints.

**Cross-account image hash claim shape is undocumented.** Tried
`copy_from={hash, source_account_id}`, `{hash, creative_account_id}`,
`copy_from=<hash>` as string — all return "Invalid parameter". May need
Business Asset Library or full re-upload.

**Cross-account video reuse is structurally limited.** Account-uploaded
videos are scoped to that account. Page videos work through `object_story_id`.

**Catalog-template Advantage+ Creative ads cannot be migrated via API.**
Identified by:
- `creative.object_type == "SHARE"`
- `creative.name` contains `{{product.name}}` or similar template
- `creative.asset_feed_spec.optimization_type == "PLACEMENT"`

The source page post is registered as a "dynamic creative" requiring a
`product_set_id`. No combination of `object_story_id`, `asset_feed_spec`,
`degrees_of_freedom_spec` payloads accepts these without one. The
constraint is on the page post, not on our request.

In one test run these accounted for **~46% of all spending ads**. Set
expectations accordingly: realistic API ceiling is roughly 50-60% of ads,
with the catalog residue needing manual rebuild in Ads Manager UI or
Meta's native bulk CSV export/import.

## Field-translation gotchas

- **Past `end_time` / `start_time`** → strip them. Meta rejects ad sets
  with end_time in the past.
- **`instagram_positions: ["explore_home", ...]`** must also include
  `"explore"`. Meta added this validation late 2025/2026; older sources
  lack it.
- **`destination_type: "UNDEFINED"`** is a read-only output value. Strip
  when writing.
- **CBO campaigns** have `daily_budget` at campaign level, not adset.
  Don't copy budget at both levels.

## Output: ALWAYS produce a handoff

- `needs-manual.csv` with: source_ad_id, ad_name, new_adset_id (so manual
  rebuild lands in the right place), new_campaign_id, creative_id,
  Facebook post URL, failure_reason
- `summary.md` with counts and percentage migrated
- `id-map.json` for any later automation (e.g. activating in waves)

## Don't repeat past mistakes

- **Don't delete anything from the ad account without explicit user
  permission**, including your own test residue. Reversibility is the
  user's decision.
- **Don't trust API "success" without verifying `account_id`** on returned
  entities. Cross-account silent-failure mode is real.
- **Don't try to perfect the API path past 60%.** The catalog ads are a
  real wall. Generate the handoff CSV and move on.

## Reference implementation

See `scripts/meta-migrate/` in this repo:
- `audit.ts` — source snapshot
- `share-audiences.ts` — audience sharing
- `recreate.ts` — main migration, structural
- `generate-handoff.ts` — `needs-manual.csv` + `summary.md`
- `README.md` — detailed how-to and lessons learned
