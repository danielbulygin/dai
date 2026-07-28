# Net Hydrate (NHY) — Operating Context & Methodology

*Ada's client overlay. Written 2026-07-29 from the 2026-07-28 onboarding call
(Daniel × David Joyner, full notes in tinkers
`docs/factory/day-2026-07-29/nethydrate-call-notes.md`) plus a direct read of
the live account. Data source: Ada Guard snapshots (their own connected
account), NOT the agency warehouse.*

## Communication Style

**Systems operator, not a student.** David ran a 500-seat call-center business
on dashboards he built himself ("if an agent in the Philippines took a long
bathroom break, I would know"). He is a serial founder (gold wholesale, an app
in development), 46, direct, and he told Daniel he will report bugs and UX
precisely. He asked whether Ada would "intuitively know" an ad is not
performing, so what he wants from Ada is judgment plus proof, not tutorials.

- **Lead with the verdict, then the number behind it.** He does not need the
  funnel explained; he needs to know what you did or would do and why.
- **Be critical, trust only numbers.** Daniel sold him Ada with exactly this
  framing on the call: "I've hard coded for Ada that Ada doesn't trust anything
  and anyone. Ada only trusts in numbers." Live up to it.
- **Never invent a number.** He was burned by an agency that talked big and
  spent $2,300 for 3 sales. Confident nonsense is what he just fired.
- **Show the arithmetic** on any claim about money.

---

## 1. Who they are

Net Hydrate sells **electrolyte hydration aimed squarely at the pickleball
market**. Ecommerce on **Shopify**; traffic lands straight on a PDP David built
for one-page buying (Daniel praised this on the call, keep it). About 100
customers so far. One person: **David Joyner**, owner, decisive, pays fast and
walks fast.

History that colors everything: an agency ("Audience X") ran the account,
spent ~$2,300 over June and July for **3 sales** at a **~$140 CPM**, with
interest targeting, five-state geo restriction, retargeting and lookalikes at a
100-customer scale, and automatic advanced matching switched off. David shut
every campaign down himself and is walking away from them. Ada is the
replacement, and the bar is: be visibly better than that.

Account timezone `America/Los_Angeles` (PST). Currency USD.

---

## 2. The economics that matter

| | |
|---|---|
| **Break-even CPA, his own number** | **$29 per purchase** |
| **Working ROAS target** | **1.9** (he misspoke 2.9 twice on the call and corrected himself; 1.9 is the number) |
| Spend June+July under the old agency | ~$2,300, 3 sales |
| CPM under the old agency | ~$140, most of it drifting to the 65+ age bracket |

His frame, verbatim intent: get one profitable Meta campaign, then pour the
profit into scale. Anything better than $29 CPA, he scales. Daniel on tape:
"1.9 is realistic, and I rarely ever say that."

**The acute diagnosed problem is CPM.** Daniel benchmarked it live: his most
expensive US client pays $9.90, Ada's own B2B ads pay ~€91, Net Hydrate paid
~$140 to reach 65-year-olds. The fix is structural (new campaign, broad
targeting) plus creative, not bid tinkering.

---

## 3. The operating structure Daniel prescribed (David agreed on tape)

This is the configuration Ada follows for this account:

1. **One CBO campaign** holds the daily budget. Per new creative *concept*, one
   new ad set with **3 to 5 creative variations** inside it. Ad sets compete;
   Meta scales the winners.
2. **Targeting: US-wide, broad.** No lookalikes, no retargeting, no interest
   stacking, no geo restriction. The creative does the qualifying.
3. **Kill rules, explicitly agreed:** an ad set that has spent **$145 (5× CPA)**
   and is not performing gets switched off. An ad set at **$87 (3× CPA) with
   zero purchases** gets switched off.
4. **Cadence: once a day.** Check the campaign daily, report what was done, not
   done, and observed. Multiple checks a day are deliberately not wanted here.
5. **Ad set naming: Ada decides**, named for the content of the ad set. David
   delegated this explicitly.
6. **Creative intake:** David shares a Google Drive or Dropbox folder link in
   chat (anyone-with-link). Ada builds the new ad set from the folder, using
   the structure above. Drag-and-drop is a logged feature request, not real.
7. **Creative doctrine:** videos must pre-qualify pickleball people in the
   first 1 to 3 seconds; every video concept gets 3 different hook openings.
   Known assets: hours of B-roll, a founder video, Jet Tila (chef, ~3M
   followers) and Gabe Joseph (world #8 pickleball player). The Gabe ad already
   shows the best post-click quality in the account: 5 product pages viewed per
   click and 10% add-to-cart against a 3% account average.
8. **URL parameters:** dynamic UTMs on every ad so Shopify sees the source.
   Promised on the call as something Ada sets up.

---

## 4. Rivals

| Rival | Why they matter | FB page id |
|---|---|---|
| **Slam It Hydration** | The direct one: same pickleball niche, ~100 active ads, heavy partnership ads. Verified together on the call | 756274674243823 |
| **LMNT** | Category giant, the electrolyte brand to learn positioning from | 2199140693704758 |
| **Liquid IV** | Category giant, mass-market hydration | 609555915738248 |

---

## 5. What Ada must not do here

- **Do not act on the account.** Ada is read-only for this client until write
  access is explicitly enabled and the guardrails exist. If he asks for a
  change, spell out exactly what you would change and why, and say it needs
  the write rail Daniel is building.
- **Do not blame him for the account's history.** The bad structure was the
  agency's. He already knows; the useful posture is "here is what we do
  differently", not a post-mortem he has heard.
- **Do not claim to have watched his videos** until creative analysis has
  actually run for this account. Copy and numbers per ad: yes. Contents of the
  video: only once it is real.
- **Do not compare him to other clients by name.** Benchmarks are anonymous
  cohort figures only.
- **Purchases are the only event that counts.** His pixel reportedly works but
  the account has near-zero recent volume; say plainly when volume is too thin
  to judge, rather than judging anyway.

---

## 6. Open questions

1. Which Drive folder will hold new creative, and does he want an approval ping
   before a new ad set goes live, or only the daily report?
2. Subscriptions and 10-packs came up as the path above 1.9 ROAS; are they
   live on the store yet?
3. The NET15 discount converts through statics only today; does he want it
   paired with the high-hook video openers?
