MERGED into BRIAN.md 2026-08-09 (bands + brand docs). Kept for provenance.

# BRIAN — proposed onboarding config (EXTRACTION — human merge required)

Generated 2026-08-06T02:37Z by scripts/onboarding-intake.ts from:
- call 1: Meet – Ada Demo for Brian Polackoff with Daniel Bulygin (2026-08-03, Fireflies `01KZ4944RTFY2JVCBP35R1ENJ7`)
- call 2: Meet – Ada Demo for Brian Polackoff with Daniel Bulygin (2026-08-05, Fireflies `01KZ91WVEDWENCANSWPGQCYS3K`)

Every value below carries the quote and timestamp it came from. Nothing here is
live until a human merges it (client .md, clients row, goal_bands).

## Goal bands (→ clients.goal_bands after review)
- **metric:** CPA
- **currency:** USD
- **dream:** $49
  > "ideally the goal is to get to a CPA of 49 bucks. Right? Yep. That would be Chef's kiss. Absolutely perfect." _(call 2, 8:40)_
- **happy:** $100
  > "I mean I'm still happy at 100." _(call 2, 9:14)_
- **nervous:** $150
  > "nervous targets, nervous. CPA is 150. Yep." _(call 2, 9:24)_
- **kill:** $300
  > "300 is the killer target." _(call 2, 9:44)_

```json
{
  "metric": "cpa",
  "currency": "USD",
  "dream": 49,
  "happy": 100,
  "nervous": 150,
  "kill": 300,
  "source": "onboarding calls 2026-08-03 + 2026-08-05 (intake extraction, reviewed by ___)",
  "updated_at": "2026-08-06"
}
```

## Money
- **offering:** B2B SaaS subscription product for subcontractors — Simply Sub
  > "we're built for, for people that want something simple... It says we're built to support your business, not take it over." _(call 2, 11:53)_
- **price:** $49/month
  > "I get paid 49 a month" _(call 2, 6:03)_
- **price:** $475/year (annual plan)
  > "if they sign up for annual, they're paying 475" _(call 2, 9:56)_
- **margin / LTV:** Unknown — brand new, no retention data yet
  > "we're so brand new, I don't have a retention yet. So I don't know really how long people are going to stay." _(call 2, 6:35)_
- **primary metric:** cpa
  > "let's only focus on website Purchases... So we can focus just on website purchases... let's establish the cost per purchase." _(call 2, 5:02)_

## Volume vs efficiency
- **stance:** _not discussed_

## Funnel
- **traffic lands:** Two landing pages: simplysub.com/lp/core (demo + purchase options) and simplysub.com/lp/purchase (purchase only, no demo option). Also regular pricing page used in current campaign.
  > "We also have another variant which is called simplysub.com.lp.purchase. Instead of Core, changed to Purchase, we took away all the options for demo. It's only Purchase." _(call 1, 31:00)_
- **converts today:** Purchase via Charge (payment processor, transitioning to Stripe); current campaign sending to regular pricing page with good conversion
  > "I send people to my regular pricing page. And I've actually had good conversion on that where there's not a lot of text, there's one button that says get started in minutes." _(call 2, 17:39)_
- **after the conversion:** Client handles customer success personally after signup
  > "I'd rather just website purchases and then I'll deal with the customer success aspect after the signup occurs. I'm more than happy to do that." _(call 2, 5:15)_

## Measurement
- **setup owner:** Previously set up by a freelancer from Pakistan via Upwork; pixel not properly configured (SHA-256 hashing missing, event match quality issues)
  > "This whole system was set up by a man in Pakistan. Good man, but I think I told you, he set up this system, was making me about 600 dollars a month" _(call 1, 22:15)_
- **conversion definition:** Purchase event on simplysub.com/lp/purchase; lead event also fires on demo booking page (GHL). Client wants to focus only on purchase events going forward.
  > "let's only focus on website Purchases... let's establish the cost per purchase." _(call 2, 5:02)_
- **trusts the numbers:** Partially — pixel reported 32 purchases in last 28 days but client believes actual number is ~22-23
  > "Not exactly, it's close, but not exactly. I think we have 22-23." _(call 1, 24:56)_
- **backend truth:** Charge (payment processor), transitioning to Stripe
  > "we use something called Charge B. Now we're changing the look to Stripe, but now we use Charge B." _(call 1, 23:21)_

## Brand
- **what they are for:** Simple, calm, non-disruptive field service / subcontractor management software for older tradespeople who are reluctant tech adopters
  > "we're built for, for people that want something simple. It says we're built to support your business, not take it over. Because these people, they don't want their operation to change. They want their operations stay exactly as it is. They just want their day to be a little less stressful." _(call 2, 11:50)_
- **audience:** Older subcontractors / tradespeople, age ~45-55+, on Facebook, reluctant software adopters
  > "my customers are not, they're not normal customers. And what I mean by that is these are people that still use Bing as their search engine. These are older people that built a bridge 50 years ago with paper and pen, pencil even. And they're like, I don't want software, but I'm getting to the point now where like, I need it, but I don't want it." _(call 2, 11:08)_
- **competitors get wrong:** Screaming about features, 'all-in-one', complexity — sounds overwhelming and threatening to the audience
  > "I can send you ad examples on Facebook that I've literally been fed where these ads are doing nothing other than screaming, saying how many features they have. They're an all in one solution. No, we're an all in one solution too. But you'll never hear me say it because all in one sounds complicated." _(call 2, 12:18)_
- **Ada must never:** Never say 'all-in-one'; never sound loud, complex, or like the software will take over their business
  > "you'll never hear me say it because all in one sounds complicated. It sounds like it's going to be the ever. It's going to be like this entity that comes into my operation and takes it over. Like, that's not us." _(call 2, 12:30)_
- **tone words:** calm, assuring, flexible, simple, subtle, soft

## Creative
- **who makes ads:** Brian makes his own content — product videos, recordings, lots of existing content
  > "I do product videos, they're all published on the site, the whole gamut... We have so much content for ads, it's not even funny." _(call 1, 15:33)_
- **cadence:** _not discussed_
- **formats:** Video preferred (30-45-60 second videos); static also used but video recommended as primary; VSL recommended for landing page
  > "when you're starting out video, video is the way to go... do like 30 second, 45 second minute long ads." _(call 2, 28:20)_
- **off-limits:** Loud, feature-screaming ads; 'all-in-one' messaging; anything that feels complex or overwhelming
  > "everything we have to do cannot be. And I can send you ad examples on Facebook that I've literally been fed where these ads are doing nothing other than screaming, saying how many features they have." _(call 2, 12:15)_

## Competitors
- **Unknown — client has a competitor document to send**
  > "I've got a competitor document as well, so I'll just include that competitor document and send everything over to your email." _(call 2, 32:36)_

## History
- **prior management:** Upwork freelancer from Pakistan; paid ~$600/month; ran for some period with zero sales; client cancelled and then ran his own ad which got sales within 24 hours
  > "he set up this system, was making me about 600 dollars a month, I, again, thought that was cheap, but, anyway, three months ago I didn't make... I didn't make a single sale. So, then I lost everything, I cancelled the subscription with him" _(call 1, 22:20)_
- **sacred / do not touch:** _not discussed_
- **known bad-data periods:** Pixel over-reporting purchases (~32 reported vs ~22-23 actual); SHA-256 hashing not implemented; two Meta pixels firing on landing page; one ad spent $730 with zero purchases (now turned off)
  > "In the last 28 days you were getting 32 purchases. Does that align with what you feel? Not exactly, it's close, but not exactly. I think we have 22-23." _(call 1, 24:40)_

## Autonomy & guidance
- **starting level:** Client deferred to Daniel/ADA on campaign decisions; agreed to turn off a campaign live on the call; comfortable with ADA auto-pausing ads and campaigns when CPA thresholds are breached
  > "Is it okay for me to just like turn it off now? Yeah, that's fine." _(call 2, 21:17)_

## Starter rules (verbatim → rules engine after review)
- Kill a campaign when it has spent $730 and generated zero purchases — template: `quiet_day`
  > "You've spent 730 bucks on that. Let me see how many purchases is generated. Zero, I think it. Yeah. Yep. Is it okay for me to just like turn it off now? Yeah, that's fine." _(call 2, 21:11)_
- Kill at CPA of $300 — template: `campaign_cost_line`
  > "300 is the killer target." _(call 2, 9:44)_
- Do not increase daily budget by more than 20% per day to avoid disrupting the algorithm — template: `custom`
  > "we don't recommend making adjustments of more than 20% per day because we don't want to disrupt the algorithm too much" _(call 2, 30:22)_

## Communication
- **channel they actually read:** WhatsApp
  > "I would prefer to use WhatsApp if you have a hook for WhatsApp. Yeah. Just because I've got freelancers that are on WhatsApp and I manage that." _(call 2, 31:54)_
- **cadence:** _not discussed_
- **other recipients:** Brian Polackoff only (direct WhatsApp)
  > "Send me anything over from WhatsApp and like I said, we'll go from there." _(call 2, 32:33)_

## Other durable facts
- **fact:** Simply Sub has over 30 customers acquired in less than one month
  > "We've got over 30 some odd customers now in less than a month." _(call 2, 11:44)_
- **fact:** Client's current active campaign CPA started at ~$52 and crept up to ~$100 before he paused it
  > "I see that you already have a hundred dollar cpa. Yes. And that's been slowly creeping up. It used to be around 52, then it kind of went a little bit higher, a little bit higher, a little bit higher." _(call 2, 19:47)_
- **fact:** Client's target audience is primarily on Facebook, age 45-55+; Instagram and TikTok considered wrong channels for this audience
  > "Instagram is for young, hip, cool people. TikTok is for teeny boppers. Facebook is where these people are living." _(call 2, 22:56)_
- **fact:** Client has existing brand documents: brand bio, competitive differentiation, additions, and brand DNA (business type, brand voice, target audience) — to be sent to Daniel
  > "I've got a brand bio why people should read about us competitive differentiation, additions and then brand DNA which covers business type, brand, voice, target audience." _(call 2, 15:24)_
- **fact:** New ads should be uploaded into the 'final product campaign' (purchase-optimised campaign)
  > "When uploading new ads, should ADA just upload everything into the final product campaign? Yeah, that's fine." _(call 2, 30:06)_
- **fact:** Daily budget being set to $80/day after turning off the underperforming $45/day campaign and consolidating into the purchase campaign at $35/day
  > "we just turned off that other ad or that other campaign for 45 a day. So if you want to dump that 45 into that 35, just. That's perfectly fine. Yeah. Actually, you know what, let's just do that now. Let's do 90 now. Yeah, so 70. Let's do 80 now." _(call 2, 30:45)_

## Gap list — ask at the next touchpoint
- [ ] Q3 — Volume vs efficiency: 10 sales at $60 or 25 at $90 — do kill thresholds bend under scale _(Volume vs efficiency trade-off not discussed; kill threshold flexibility under scale not addressed.)_
- [ ] Q8 — Competitors: three names, which they actually fear and why _(Competitor names not stated on the calls; client said he has a competitor document to send but no names were given verbally.)_
- [ ] Q12 — Communication: which channel they actually read, cadence, who else gets reports _(Report cadence not discussed; only communication channel (WhatsApp) and primary recipient (Brian) were established.)_
