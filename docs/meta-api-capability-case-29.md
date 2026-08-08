# Corpus Case 29 (standalone — fold into docs/meta-api-capability-tests.md when the
# ada-action-log-and-account-guard branch lands; that file only exists there today)

## Creative reads on a partner-shared customer account (SimplySub probe, 2026-08-09)

**Shape:** `act_<id>/ads?fields=name,creative` then
`/<creative_id>?fields=video_id,object_story_spec,asset_feed_spec,thumbnail_url`
(personal user token, Ada app).

**Result:** creative ids, thumbnails, story specs and copy are all readable on a freshly
partner-shared customer account (24 creatives: 12 video, 12 link/image). The video FILE
(`source`) is withheld: page-content gate. The Ada SYSTEM-USER token gets #200 on every ad
account including the practice account (the Ada app is in Marketing API development tier —
the fix is the one-time "Ads Management Standard Access" request; the BM assignments were
verified correct via assigned_pages / assigned_ad_accounts and are not the problem).

**Trap (cost an hour):** curly braces in `fields=` expansions MUST be percent-encoded, or
curl must run with `-g` — otherwise curl URL-globs the braces, fires split/doubled requests,
and the expanded field silently disappears, which reads exactly like a permissions wall.
Regression check: bare `fields=creative` returning ids while unencoded `fields=creative{id}`
returns none means the problem is your curl, not Meta.
