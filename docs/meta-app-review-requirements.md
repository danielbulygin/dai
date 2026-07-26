# Meta App Review — everything to request, in one submission

**Purpose:** App Review cycles are slow and re-submitting is painful, so this is the single
place listing everything we need, so nothing is discovered as missing *after* filing.

**Status as of 2026-07-26:** not filed. The roadmap says file it Monday 27 July regardless
of how BM partner access lands, since the clock only starts on submission.

**App:** "Ada", id `1063235528629774`. Long-lived user token, no expiry.

---

## What the app already has

Verified 2026-07-26 via `GET /v22.0/debug_token`:

```
read_insights           pages_show_list         ads_management
ads_read                business_management     pages_read_engagement
pages_read_user_content public_profile
```

⚠️ **Having a scope is not the same as having Advanced Access to it.** The roadmap notes
`ads_management` is "weeks away for every customer", which is the Advanced Access problem,
not the scope. Confirm the *access level* of each of the above in the dashboard, not just
its presence. Standard Access only works on accounts the app's own users have a role in.

## What is missing

Grouped by the product capability it unblocks, so each can be justified with a real use
case, which App Review requires.

### A. Ads on customer accounts — the beta blocker

| Need | Kind | Evidence / why |
|---|---|---|
| `ads_management` at **Advanced Access** | Access level | Standard Access cannot write to a customer's ad account. Roadmap: this is what makes autopilot "weeks away for every customer"; Monday is propose-mode because of it. |
| Business verification | Prerequisite | Required before Advanced Access on any of the below. Do this first or everything else stalls. |

### B. Comments — Ada's comment moderation and mining

From `bmad/docs/ada-comment-moderation-scope-2026-06-26.md`. All Advanced Access, all
requiring App Review plus a business-verified app.

| Need | Kind | What breaks without it |
|---|---|---|
| `pages_manage_engagement` | Permission | Cannot hide, delete, like, or reply to a Facebook comment. Read-only comments only. |
| `instagram_manage_comments` | Permission | No Instagram comment read, hide, or delete at all. |
| `pages_read_user_content` | Permission | Already granted — **confirm it is Advanced, not Standard.** |

Note `pages_messaging` / private replies were considered and **dropped** by Dan 2026-06-27.
Do not request it; unnecessary scopes make review harder.

### C. Partnership ads — discovered 2026-07-26

Full investigation in `meta-api-capability-tests.md`. Two separate gaps:

| Need | Kind | Evidence |
|---|---|---|
| `instagram_basic` | Permission | **No Instagram scopes on the app at all.** `business_discovery` to resolve a creator handle fails with `#10 Application does not have permission for this action`. |
| `instagram_manage_insights` | Permission | Likely needed for Instagram-side reporting. Lower confidence than the above. |
| **Branded content / partnership ads capability** | App Review **Feature** | Reading `branded_content{partners}` and writing it via either `ig_user_id` or `fb_page_id` both fail with `#3 Application does not have the capability to make this API call`. Confirmed identical on **v19.0 through v24.0**, so it is a capability gate, not a version issue. |

⚠️ **The exact name of that Feature is not published by Meta.** Checked the Partnership Ads
API page, the Partnership Ads Creation page, the Branded Content guide, and searched. **Read
it off the App Dashboard** → App Review → Permissions and Features, which enumerates every
available feature with its status. Meta also offers a direct application route for branded
content tool access: <https://www.facebook.com/help/contact/1865970047013799>

**Do not file without resolving this name.** It is the one item here that cannot be
requested by guessing, and it is precisely the kind of thing that forces a second
submission.

### D. Cross-page reads — probably needed, lower confidence

| Need | Kind | Evidence |
|---|---|---|
| Page Public Content Access | Feature | Reading a post on a page we do not administer failed: *"requires the 'pages_read_engagement' permission or the 'Page Public Content Access' feature"* — and we DO hold `pages_read_engagement`, so the page-role requirement is what bit. Relevant to any competitor or cross-client post analysis. |

---

## Not obtainable through App Review

Worth stating so nobody expects the submission to unlock them:

- **Creator permission for a partnership ad.** Granted by the creator in the Partnership Ads
  Hub / Instagram, either account-level (creator approves the brand) or post-level (brand
  approves the creator's post). Still required after the capability lands.
- **Instagram account identity verification.** The practice account's Instagram id
  (`17841469793617911`) is accepted by Meta on 74 live ads but cannot be resolved by our
  System User token. `instagram_basic` may fix this; if not, it needs a Page token or a look
  in Business Manager.

## Pre-submission checklist

- [ ] Business verification complete (gates everything else)
- [ ] Read the branded content Feature's real name off the App Dashboard
- [ ] Confirm the **access level** (Standard vs Advanced) of every scope we already hold
- [ ] One written use case per permission — reviewers reject vague justifications
- [ ] Screencast per permission showing the in-product flow
- [ ] Drop `pages_messaging` from any draft; it was explicitly descoped

## After the outcome

Re-run the probe table in `meta-api-capability-tests.md` (partnership ads section). The
moment the capability errors turn into real responses, partnership ads become buildable and
the schema is already documented there. That is the cheapest possible detection.
