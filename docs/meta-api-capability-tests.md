# Meta API capability tests

A living record of actions we have actually performed against the practice account,
with the exact request that worked and the result we expect. The point is regression:
when Meta changes the Graph API, or when we change the safety layer, re-running these
tells us what broke rather than us finding out through a client.

Started 2026-07-26. **Append as we test. Never delete a case — if behaviour changes,
record the change and the date.**

## Ground rules

- **Practice account only:** `act_1570076840279279` (Ads on Tap USD, client code `AOT`).
- **Pre-flight every session, before anything else:** every campaign off, and no spend
  in the last 7 days. If either fails, stop and tell Daniel. This is a standing rule.
- **The campaign stays off.** Ads and ad sets may be switched on and off freely: a
  paused campaign means zero delivery regardless, so nothing spends. Never turn a
  campaign on.
- **Validate before you write.** Meta supports a dry run via
  `execution_options=["validate_only"]`. Use it on every create. It caught a required
  field on the very first case below, before any real object existed.
- Graph API version in use: **v22.0** (the safety layer's version). Note the insights
  libraries elsewhere still sit on v21.0.

## How to verify a change (read this before adding a case)

Every case below must verify by **reading the object back from the API**, never by
trusting the write response. A `{"success": true}` means the call was accepted, not that
the object looks how you intended.

**Verify by diffing the whole object, not the fields you changed.** This is the lesson of
2026-07-26. Adding a campaign budget silently set `bid_strategy` to bid cap. It was caught
only because that field happened to be in one read-back. Had we checked only
`daily_budget` — the field we actually changed — the campaign would have kept a bid
strategy nobody chose, and since Daniel's rule is that bid strategy can never be changed
after creation, on a real campaign that would have been unrecoverable.

So the procedure is:

1. **Dry run** with `execution_options=["validate_only"]`.
2. **Snapshot the whole object** before the write, using a field list far wider than what
   you are changing.
3. **Write.**
4. **Snapshot again and diff.** Then assert three separate things:
   - every field you asked for actually took (catches silently-dropped params)
   - no field you did *not* ask for changed (catches Meta's unrequested defaults)
   - the invariant still holds: all campaigns off, spend still zero
5. **Log it**, with before, after, and how to undo.

`effective_status` and `updated_time` are excluded from the diff, since Meta legitimately
recomputes them.

A session helper implementing all of this lives in the scratchpad as `meta-write.mjs`. It
refuses any account other than the practice account, refuses to set a campaign active, and
will not perform a write without verifying it. **If this methodology is worth keeping, the
helper should move into the repo rather than living in a temp directory** — currently it
does not survive the session.

## Pre-flight

```bash
# every campaign must be PAUSED
curl -sG "https://graph.facebook.com/v22.0/act_1570076840279279/campaigns" \
  -d "fields=id,name,status,effective_status" -d "limit=100" -d "access_token=$TOKEN"

# and there must be no spend
curl -sG "https://graph.facebook.com/v22.0/act_1570076840279279/insights" \
  -d "date_preset=last_7d" -d "fields=spend,impressions" -d "access_token=$TOKEN"
```

Expected: every campaign `PAUSED`, insights `data: []`.

Verified 2026-07-26: 4 campaigns all off, 37 ad sets all under off campaigns, zero
spend for 7 days and zero today.

---

## Case 1 — Create a campaign with a leads objective

**Who can do this:** nobody in our system. The safety layer explicitly cannot create,
modify, or delete campaigns, and no tool exists. This case documents the direct API
route, which is what a person (or Claude in a terminal) uses. **It is ungoverned:** it
does not pass the locked-campaign fence, the spend guard, or the audit log. That is
worth remembering whenever someone says "Ada created a campaign."

```bash
curl -s -X POST "https://graph.facebook.com/v22.0/act_1570076840279279/campaigns" \
  -d "name=AOT // API TEST // Leads // 26 Jul 2026" \
  -d "objective=OUTCOME_LEADS" \
  -d "status=PAUSED" \
  -d "special_ad_categories=[]" \
  -d "buying_type=AUCTION" \
  -d "is_adset_budget_sharing_enabled=false" \
  -d "access_token=$TOKEN"
```

**Expected:** `{"id": "<numeric>"}`, and on read-back `status=PAUSED`,
`effective_status=PAUSED`, `objective=OUTCOME_LEADS`, no `daily_budget` or
`lifetime_budget` at campaign level.

**Result 2026-07-26:** created `120247186199170225`. Read-back matched exactly.

### API contract detail worth keeping

The first attempt failed, and the dry run is what caught it:

> `error_subcode 4834011` — "You must specify True or False in the field
> `is_adset_budget_sharing_enabled` if you are not using campaign budget."

So **when you omit a campaign budget, that field is now mandatory** rather than
defaulted. If this case ever starts failing with subcode 4834011, Meta has changed the
requirement again. We set it to `false` deliberately: with sharing enabled, ad sets
lend each other up to 20% of budget, which would make any ad-set budget assertion
unreliable.

### Budget level is Daniel's decision, not a default

First attempt created this campaign with an ad-set-level budget, on the reasoning that it
made an ad-set budget change testable. Daniel's correction: *"I would have expected you to
ask me what type of campaign that should be."* Campaign structure is the substance of
media-buying work, not a detail on the way to it. **Ask.**

He chose campaign-level budget at $20/day. Converting in place worked, so no delete and
recreate was needed:

```bash
curl -s -X POST "https://graph.facebook.com/v22.0/<CAMPAIGN_ID>" \
  -d "daily_budget=2000" -d "access_token=$TOKEN"     # 2000 = $20.00, USD account
```

### GOTCHA: adding a campaign budget silently changes the bid strategy

After the conversion above, read-back showed `bid_strategy=LOWEST_COST_WITH_BID_CAP`,
which was never requested. It does not inherit the account convention and nothing in the
response mentions it. Every other campaign in the account uses
`LOWEST_COST_WITHOUT_CAP`.

Consequence in a real account: you inherit a bid strategy nobody selected, and every ad
set underneath then needs an explicit bid cap value.

**Always read `bid_strategy` back after touching a campaign budget**, and reset it:

```bash
curl -s -X POST "https://graph.facebook.com/v22.0/<CAMPAIGN_ID>" \
  -d "bid_strategy=LOWEST_COST_WITHOUT_CAP" -d "access_token=$TOKEN"
```

---

## Case 2 — All three bid strategies, side by side

Created 2026-07-26 so each shape can be tested and compared. All leads objective, all
campaign-level budget at $20/day, all PAUSED.

| Campaign | `bid_strategy` | Id |
|---|---|---|
| `AOT // API TEST // Leads // Lowest Cost // 26 Jul 2026` | `LOWEST_COST_WITHOUT_CAP` | `120247186199170225` |
| `AOT // API TEST // Leads // Bid Cap // 26 Jul 2026` | `LOWEST_COST_WITH_BID_CAP` | `120247186255230225` |
| `AOT // API TEST // Leads // Cost Cap // 26 Jul 2026` | `COST_CAP` | `120247186255420225` |

Both cap strategies validated and created cleanly with the strategy set **at creation
time**, no cap value required at campaign level. The cap amount is an ad-set field
(`bid_amount`), so these campaigns are usable as-is and the cap only becomes mandatory
when an ad set is added.

**Standing default (Daniel, 2026-07-26): always `LOWEST_COST_WITHOUT_CAP`.** Only use bid
cap or cost cap when he asks for one proactively. The two cap campaigns above exist as
test fixtures, not as a pattern to copy.

---

## Media-buying rules that constrain what we may test

Not API behaviour. Daniel's rules, and they override convenience.

**Never edit an ad set or an ad that has received spend.** Editing settings after spend
resets Meta's learning phase and throws away the optimisation that spend paid for. The
correct response to "change this winner" is normally "build a new one".

**What IS allowed on a spent or running ad set:**
- Pausing individual ads inside it.
- Adding new ads to it while it runs.

**At campaign level: never change the bidding strategy or the conversion goal.** Not on
anything active, not on anything that has ever spent, and as a habit not after creation at
all. Build a new campaign instead.

This makes the creation-time choice the whole decision, and it is why the silent bid-cap
default above is dangerous rather than annoying: on a real campaign you would be stuck
with it permanently. Correcting it is legitimate only on a brand-new, never-active,
zero-spend campaign where the value was an API default nobody chose — which was the case
here on 2026-07-26. Do not generalise from that.

**Standing default: bid strategy is always lowest cost** (`LOWEST_COST_WITHOUT_CAP`). Use
bid cap or cost cap only when Daniel asks proactively.

**Ask before choosing structure.** Campaign vs ad-set budget is a media-buying decision,
not an implementation detail. Same for optimisation goal. Flagging a choice after making
it is not the same as asking. (Naming format, API version, and validate-first are not in
this category — those are routine.)

Our safety layer already enforces a version of this (see R5–R8 below): on an object with
lifetime spend it permits only `name` and status→PAUSED/ARCHIVED. Two differences worth
noting: it still allows a **rename** on a spent object, which the rule as stated would
not; and it only engages once spend is above zero, which is consistent, since an unspent
object has no learnings to lose.

---

## Rail behaviours to re-verify

These are the protections themselves. They are not Meta API behaviour, they are ours,
and they are the things that must never silently stop working. All verified by
execution on 2026-07-26 against the practice account.

Run via the safety layer directly:

```python
import sys; sys.path.insert(0, '<bmad>/pma/tools/creative-uploader')
import safe_meta_api as S
api = S.SafeMetaAPI(S.get_access_token('AOT'), 'AOT')
```

| # | Check | Expected |
|---|---|---|
| R1 | Constructing for an unknown client (e.g. `MTN`) | `SafetyError` before any network call |
| R2 | `pause_adset` on an ad set outside the locked campaign | `SafetyError` naming both campaigns |
| R3 | `pause_ad` / `pause_adset` inside the locked campaign | Succeeds |
| R4 | Rename via `set_adset_action_marker` | Succeeds, and is undone by `clear_adset_action_marker` |
| R5 | Budget change on an object **with** lifetime spend | Refused by the spend guard |
| R6 | `status=ACTIVE` on an object **with** lifetime spend | Refused by the spend guard |
| R7 | Rename on an object with spend | **Allowed** — a name cannot affect delivery |
| R8 | `status=PAUSED` on an object with spend | **Allowed** — the kill switch must always work |
| R9 | Any campaign create/modify/delete method | Does not exist |
| R10 | Any delete/archive method | Does not exist |

**Known limitation, asserted rather than hidden:** R5 and R6 only bite once an object
has spent. On a brand new object the guard permits both, including turning it on. Ada
has no verb to ask for either, so this is not currently reachable, but the protection
is narrower than "Ada cannot turn things on".

Guard-level equivalents live in `tests/guard-account-allowlist.test.ts` and run with
`pnpm test`.

---

## MANDATORY: account readiness, before changing anything

Dan, 2026-07-26: *"prior to making changes in the account, you need to know: which is the
correct data set ID, which is the standard conversion event, the URL mapping, the correct
Instagram and Facebook page IDs."*

**Every account has its own.** Carrying another account's values across is how ads end up
on the wrong page, firing the wrong event, or pointing at a dead URL. This is not optional
and it is not a checklist someone reads — it is code:

```ts
import { accountReadiness, formatReadiness, preflight } from './scripts/meta-write.js';

const safety = await preflight();                       // campaigns off? no spend?
const ready  = await accountReadiness(ACCOUNT, URLS);   // the four questions
console.log(formatReadiness(ready));
if (!ready.ok) throw new Error('blockers — do not build');
```

It **discovers the answers from the account itself** — the pixel, event, page and Instagram
account that live objects actually use — rather than trusting config. That means it works
on a brand-new client account with no config at all, which is the onboarding case, and it
catches config that has drifted from reality.

Verdicts: `pass` established and consistent · `warn` usable but a human should look ·
`fail` do not build.

**Two checks deserve special weight**, because per Daniel's rule the conversion goal and
bid strategy are FIXED at creation and cannot be corrected later. A wrong pixel or event is
not a tidy-up job afterwards, it is a rebuild.

### Result for the practice account, 2026-07-26

```
⚠️  Dataset / pixel:    480938037639047 — but 2 pixels in use (36/37 vs 744943614558963)
⚠️  Conversion event:   LEAD — but 2 in use: LEAD (27), PURCHASE (10)
✅ Optimisation goal:  OFFSITE_CONVERSIONS
✅ Facebook page:      476517508878115 "Ads On Tap", published, all 74 ads
✅ Instagram:          17841469793617911, all 74 ads (not independently verifiable)
⚠️  adsontap.io/       200 but redirects to ads-on-tap.com
❌ adsontap.io/about   404
✅ adsontap.io/contact 200
❌ adsontap.io/services 404
→ 2 BLOCKERS, 3 warnings. Do not build.
```

The split conversion event is the sharpest finding: 27 LEAD vs 10 PURCHASE means there is
no safe majority to assume, and the choice cannot be undone. Ask.

**This should become an Ada skill.** She needs the same check before any launch, and she
currently has no equivalent. Blocked behind the skills-reachability work.

## Account defaults — the two places config lives

Every ad account has its own page, Instagram account, pixel and URL mapping. Never assume;
they are per-account. For the practice account (`AOT`), config lives in two places that can
drift apart:

- `safe_meta_api.py` → `CLIENT_CONFIGS['AOT']` (page, Instagram, pixel, locked campaign,
  targeting defaults, url_tags)
- Supabase `client_meta_configs` row (landing page mapping, CTA, naming templates,
  compliance rules)

**Verified 2026-07-26:**

| Thing | Value | Status |
|---|---|---|
| Ad account | `act_1570076840279279` | USD, Europe/Berlin, active |
| Page | `476517508878115` | ✅ resolves to "Ads On Tap", published, used by all 12 existing ads |
| Instagram | `17841469793617911` | ⚠️ used successfully by all 12 existing ads, but **not independently verifiable** with our System User token |
| Pixel | `480938037639047` | Used by 36 of 37 ad sets (one uses `744943614558963`) |
| Default CTA | `LEARN_MORE` | |
| url_tags | `utm_source=facebook&utm_medium=cpc&...` | |

**Instagram cannot be verified with the agency token.** Three routes all fail: direct GET
on the actor id (`error_subcode 33`), the page's `instagram_accounts` edge (needs a *Page*
access token, `#190`), and `act_*/instagram_accounts` (returns empty). The only evidence
the id is correct is that Meta accepted it on 12 live ads. To confirm the actual handle,
use a Page token or Business Manager.

### URL mapping — 2 of 4 dead as of 2026-07-26

| Keyword | URL | Result |
|---|---|---|
| `default` | `https://adsontap.io/` | 200 but **redirects to `https://ads-on-tap.com/`**, title "Ads On Tap — Design Directions" |
| `agency` | `https://adsontap.io/about` | **404** |
| `contact` | `https://adsontap.io/contact` | 200 |
| `services` | `https://adsontap.io/services` | **404** |

The domain appears to have moved from `adsontap.io` to `ads-on-tap.com` while the mapping
still points at the old one. Redirects are where tracking parameters get lost, so this
matters beyond tidiness. The default destination also looks like a design page rather than
a homepage — needs Daniel's eye before any real ad points at it.

The 404s return an honest 404 status with a branded page, not a soft-404, so an automated
check catches them cleanly.

**Check URLs like this** (follow redirects, compare the final URL, read the title):

```bash
curl -s -o /tmp/b.html -w "%{http_code}" -L --max-time 20 \
  -A "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36" "$URL"
curl -s -o /dev/null -w "%{url_effective}" -L --max-time 20 "$URL"   # did it redirect?
```

The production version of this is the `ada-dead-url-scan` skill (daily, all clients,
browser-confirms before alerting). Note it is one of the skills Ada cannot currently reach
— see the skills-reachability backlog item.

## Partnership ads — investigated 2026-07-26, NOT built

Daniel asked for a partnership-ad creation capability, pointing at a Brain.fm ad as the
reference (account `act_1726935217614830`, campaign `120225649475980041`, ad set
`120245404667740041`, ad `120245404667760041` — all extractable from an Ads Manager URL).

**Read-only investigation of that account. Nothing was written to it.**

What the reference ad actually shows:

| Field | Value |
|---|---|
| `branded_content` | `{ "ad_format": 3 }` — **the only ad of 25 sampled that has this set** |
| `object_story_spec.page_id` | `1521753578089107` = "Brain.fm" — their OWN page |
| `object_story_spec.instagram_user_id` | `17841406011611363` = `@brainfmapp` — their OWN Instagram |
| `branded_content_sponsor_page_id` | empty |
| `source_instagram_media_id` | empty |
| `instagram_permalink_url` | `instagram.com/p/DYlGDD2AHpZ/` |

Fields that **do not exist** in v22.0: `partnership_ad_code`,
`branded_content_sponsor_relationship`, `branded_content.creator_page_id`.

### Why this is not enough to build from

1. **The API does not expose the partner.** The creative carries the branded-content
   marker but no partner or creator identity. There is nothing to reverse-engineer.
2. **The reference ad may not be a true partnership ad.** It uses Brain.fm's own page and
   own Instagram, identical to the other 24 ads, with no sponsor and no creator post. The
   ad name credits "(Jack Yappers Scripts)", which reads like a script author, not a
   partner. Either the partner is visible only in the UI, or this is Brain.fm's own
   creative carrying a branded-content format flag.
3. **Permission is granted OUTSIDE the API.** Meta's own docs are explicit: delivery
   requires *"account-level permissioning for the creator approved by the brand or
   post-level permissioning for the brand approved by the creator"*, arranged through the
   Partnership Ads Hub / Instagram, not through the Marketing API. So no amount of API work
   creates a working partnership ad on its own.
4. A dry run of a creative carrying `branded_content: {"ad_format": 3}` **does validate**
   in the practice account. That proves the payload is structurally acceptable, nothing
   more. A branded-content flag with no partner behind it is not a partnership ad, and
   validate_only will not catch that.

### RESOLVED 2026-07-26: the schema, and the exact blocker

Daniel supplied the partner handle (`roas.dan`), which made a deeper probe worthwhile.

**Scanned all 1,200 ads in the Brain.fm account.** Exactly **4** carry `branded_content`,
and 3 of them are named "Dan Yapper - Masking" — the `roas.dan` partnership. All 1,200 ads
use the same Instagram id (Brain.fm's own), confirming the partner is NOT stored in
`object_story_spec`.

**The schema, discovered by probing** (invalid keys produce "Unexpected key", valid ones
produce a different error, so the API enumerates its own schema):

```jsonc
branded_content: {
  ad_format: 3,                                  // writable on its own
  partners: [ { ig_user_id: "<creator IG id>" } ] // OR { fb_page_id: "<page id>" }
}
```

`partners[0]` accepts **exactly two** keys: `ig_user_id` and `fb_page_id`. Everything else
(`page_id`, `id`, `creator_id`, `instagram_actor_id`, `partner_id`, `igid`,
`instagram_id`, `instagram_account_id`, `ig_id`) is rejected as an unexpected key.

**The blocker is app capability, not our code and not config:**

| Operation | Result |
|---|---|
| READ `branded_content{partners}` | ❌ `#3 Application does not have the capability to make this API call` |
| WRITE `partners: [{ig_user_id}]` | ❌ same capability error |
| WRITE `partners: [{fb_page_id}]` (valid page) | ❌ same capability error |
| WRITE `branded_content: {ad_format: 3}` alone | ✅ validates — but produces a branded-content flag with **no partner**, which is not a partnership ad |
| `business_discovery` to resolve `roas.dan` | ❌ `#10 Application does not have permission for this action` |

So the Brain.fm partnership ads were almost certainly created **in Ads Manager by a
human**, using Meta's own first-party app which holds the capability. Our app does not.

### What is needed before this can be built

Two separate requirements, and BOTH are needed. Neither is code.

1. **App capability from Meta for branded content / partnership ads.** This is an App
   Review / feature request against the app whose token we use. Until it is granted, the
   partner field cannot be read or written by us at all. **This should be added to the
   already-planned App Review bundle** (pages + ads_management) rather than raised as a
   separate request.
2. **Creator permission from the partner**, granted outside the API in the Partnership Ads
   Hub / Instagram: either account-level (creator approves the brand) or post-level (brand
   approves the creator's post). Meta's docs are explicit that delivery requires this. It
   is still required *after* the capability is granted.

Then a decision on which flow: promoting a creator's existing organic post (needs the media
id plus post-level permission) versus our own creative carrying a partner credit (needs
account-level permission). Different builds.

**Until the capability lands, the honest status is: cannot be built.** Writing
`branded_content: {ad_format: 3}` alone would pass validation and produce something that
looks like a partnership ad in our code and is not one in Meta. That is worse than not
building it.

**Regression value:** re-run the probe table above after any App Review outcome. The moment
those capability errors turn into real responses, this becomes buildable, and the schema is
already documented here.

Sources: [Partnership Ads API](https://developers.facebook.com/docs/marketing-api/ad-creative/partnership-ads/),
[Partnership Ads Creation](https://developers.facebook.com/docs/marketing-api/ad-creative/partnership-ads/ads-creation/),
[Branded Content](https://developers.facebook.com/docs/marketing-api/guides/branded-content/)

## Objects created for testing

Anything here is disposable. If a session ends without cleaning up, that is fine while
the campaign is off, but do not let this list grow forever.

| Created | Object | Id | State |
|---|---|---|---|
| 2026-07-26 | Campaign, Lowest Cost | `120247186199170225` | PAUSED, empty, $20/day CBO |
| 2026-07-26 | Campaign, Bid Cap | `120247186255230225` | PAUSED, empty, $20/day CBO |
| 2026-07-26 | Campaign, Cost Cap | `120247186255420225` | PAUSED, empty, $20/day CBO |

## Open questions / not yet tested

- Ad-set-level budget change. Still untestable: all seven campaigns in the account now
  hold budget at campaign level, so no ad set has a budget of its own. Needs either an
  ad-set-budget campaign or Daniel's go-ahead to convert one.
- Creating ad sets and ads in these campaigns (the "maximizing conversions" optimisation
  goal lives on the ad set, not the campaign).
- Whether a cap strategy campaign refuses an ad set that omits `bid_amount`.
- Adding an ad to a *running* ad set, which Daniel confirms is allowed. Cannot be tested
  here while every campaign is off, so it needs a different approach or a read of a live
  client account.
