# SimplySub (BRIAN): Operating Context & Methodology

*Ada's client overlay. Written 2026-08-09 from the two onboarding calls with
Brian Polackoff (2026-08-03 and 2026-08-05, Fireflies transcripts; extraction
kept at `agents/ada/clients/_intake/BRIAN-proposed.md`) plus the six brand
documents Brian sent on 2026-08-05: Brand Bio, Brand DNA, Competitive
Differentiation, Competitor Landscape (Version 1, August 2026), Core
Principals, and Why people should read about us. Data source: Ada Guard
snapshots of his own connected account.*

## Communication Style

**One owner, decisive, short on patience for talk without sales.** Brian runs
SimplySub himself. He builds his own landing pages, shoots his own product
videos, and he turned a losing campaign off live on the call the moment the
numbers were on screen. He also just came out of a bad arrangement: an Upwork
freelancer charged him about $600 a month, three months went by with no sales,
he cancelled, and then he ran his own ad and had sales inside 24 hours. He said
it plainly: *"he set up this system, was making me about 600 dollars a month, I,
again, thought that was cheap, but, anyway, three months ago I didn't make... I
didn't make a single sale. So, then I lost everything, I cancelled the
subscription with him."*

So:

- **Short answers. Say the thing, then the number behind it.** He does not need
  the funnel explained back to him.
- **Never state a purchase count without saying where it came from.** His pixel
  overcounts (see section 4). If you quote Meta's number, label it as Meta's
  number.
- **Never invent a figure.** He has already paid for confident work that
  produced nothing.
- **Show the arithmetic** on anything about money.
- **Plain words only.** No jargon, no slogans. This matters twice over here,
  because plain and calm is also his brand rule (section 5), so anything you
  write for him should already read the way his ads need to read.
- **Give him a recommendation.** On both calls he deferred to Daniel and Ada on
  campaign decisions. He wants a call made and the reason for it, then he
  decides.

---

## 1. Who they are

SimplySub is a B2B software subscription for **subcontractors and specialty
trade contractors**: job tracking, crew time and attendance, equipment and
materials, estimating, job photos, documentation, daily logs, invoices, and a
QuickBooks connection. Trades named in the brand docs: grading, concrete,
masonry, landscaping, framing, plumbing, electrical, fencing, roofing.

One person to talk to: **Brian Polackoff**, founder. He does customer success
himself after every signup, by choice: *"I'd rather just website purchases and
then I'll deal with the customer success aspect after the signup occurs. I'm
more than happy to do that."*

The business is new. Over 30 customers in under a month at the time of the
second call (*"We've got over 30 some odd customers now in less than a
month."*), and no retention history yet: *"we're so brand new, I don't have a
retention yet. So I don't know really how long people are going to stay."* That
is why CPA is the only target and there is no LTV or payback number to lean on.

Currency USD. Market is US-based subcontracting businesses.

---

## 2. Goal bands and the economics that matter

**Metric: CPA (cost per website purchase). Currency: USD.**

| Band | Value | His words |
|---|---|---|
| **Dream** | **$49** | *"ideally the goal is to get to a CPA of 49 bucks. Right? Yep. That would be Chef's kiss. Absolutely perfect."* |
| **Happy** | **$100** | *"I mean I'm still happy at 100."* |
| **Nervous** | **$150** | *"nervous targets, nervous. CPA is 150. Yep."* |
| **Kill** | **$300** | *"300 is the killer target."* |

```json
{
  "metric": "cpa",
  "currency": "USD",
  "dream": 49,
  "happy": 100,
  "nervous": 150,
  "kill": 300,
  "source": "onboarding calls 2026-08-03 + 2026-08-05, confirmed by Daniel 2026-08-09; brand docs from Brian 2026-08-05",
  "updated_at": "2026-08-09"
}
```

Supporting numbers:

| | |
|---|---|
| Price | **$49 per month** (*"I get paid 49 a month"*) |
| Annual plan | **$475 per year** (*"if they sign up for annual, they're paying 475"*) |
| Margin and LTV | **Unknown.** No retention data yet. Do not calculate payback or LTV for him |
| Where his CPA actually sat | Started around **$52**, drifted to about **$100**, and he paused that campaign on the call |
| Daily budget after the call | **$80 per day**, after switching off a $45/day campaign and folding it into the $35/day purchase campaign |

The dream band and the monthly price are the same number, $49. That is a
coincidence of the two figures, not a payback rule. One month of subscription
does not pay back a $49 CPA. If he asks whether $49 CPA is profitable, the
honest answer is that nobody knows yet because there is no retention data, and
the annual plan at $475 is the version that clearly pays back quickly.

---

## 3. The funnel

- **Landing pages.** Two purpose-built pages exist: `simplysub.com/lp/core`
  (demo option plus purchase) and `simplysub.com/lp/purchase`, which is the same
  page with the demo options removed. In his words: *"Instead of Core, changed
  to Purchase, we took away all the options for demo. It's only Purchase."*
- **The page that is currently converting is his regular pricing page**, not
  either LP: *"I send people to my regular pricing page. And I've actually had
  good conversion on that where there's not a lot of text, there's one button
  that says get started in minutes."* Treat that as a finding worth respecting.
  A page with little text and one button is working on this audience.
- **What counts as a conversion: website purchase only.** He was explicit:
  *"let's only focus on website Purchases... So we can focus just on website
  purchases... let's establish the cost per purchase."*
- A **lead event also fires** on the demo booking page (GHL). It is not the
  optimisation event and not a reporting metric here. Do not present lead counts
  as progress.
- **After the purchase, Brian takes over** personally for onboarding and
  customer success.
- **Channel: Facebook.** His audience is there and he does not want the others:
  *"Instagram is for young, hip, cool people. TikTok is for teeny boppers.
  Facebook is where these people are living."* Do not propose Instagram-led or
  TikTok-style creative for this account without raising it as a question first.

---

## 4. Measurement: what to trust

**The pixel overcounts purchases by roughly 30%.** Meta reported 32 purchases in
a 28-day window; Brian's own count was 22 to 23. *"In the last 28 days you were
getting 32 purchases. Does that align with what you feel? Not exactly, it's
close, but not exactly. I think we have 22-23."*

Known causes and history:

- **Two Meta pixels are firing** on the landing page.
- **SHA-256 hashing was never implemented**, so event match quality is poor.
- The original setup was done by the Upwork freelancer, and it was not
  configured properly.
- One ad spent **$730 with zero purchases** and has been switched off.

**The backend is the truth.** Payments run through Chargebee, and he is moving
to Stripe: *"we use something called Charge B. Now we're changing the look to
Stripe, but now we use Charge B."*

How this changes your reporting:

1. When you report purchases or CPA from Meta, say it is Meta's figure and that
   it has been running about 30% high against his own count.
2. When the difference between a good week and a bad week is smaller than that
   30% gap, say the data cannot settle it yet.
3. Ask him for the Chargebee or Stripe number when a decision turns on the exact
   count. He has it and he checks it.
4. Do not describe the overcount as fixed. Until the duplicate pixel is removed
   and hashing is in place, it is still there.

---

## 5. Brand: who this is for and how to talk about it

This section governs every piece of ad copy, hook, and script you write or
judge for this account. It comes from the two calls and the six brand documents.

### Who the product is for

Older subcontractors who run small and midsize trade businesses and who do not
want software. Brian described them at length:

> *"my customers are not, they're not normal customers. And what I mean by that
> is these are people that still use Bing as their search engine. These are
> older people that built a bridge 50 years ago with paper and pen, pencil even.
> And they're like, I don't want software, but I'm getting to the point now
> where like, I need it, but I don't want it."*

Roughly 45 to 55 and up, on Facebook, reluctant to adopt anything new. They have
grown a real business on spreadsheets, paper, group texts, and what the owner
keeps in his head, and that is starting to break as they add crews, customers,
and jobs at the same time. The brand documents add the other people in the
building who end up using the product: office administrators, field managers,
foremen, and crew leaders, with mixed levels of comfort with technology.

Write to the owner who resists software. He is the one who clicks.

### What the brand is

Simple, calm, supportive. Brian's own summary:

> *"we're built for, for people that want something simple. It says we're built
> to support your business, not take it over. Because these people, they don't
> want their operation to change. They want their operations stay exactly as it
> is. They just want their day to be a little less stressful."*

The brand documents say the same thing in their own words. Competitive
Differentiation: *"Rather than requiring contractors to change how their
businesses operate to accommodate the software, SimplySub is designed to fit
naturally into familiar construction workflows."* Brand Bio: *"Ease of use is
central to the SimplySub brand. Construction software only creates value when
employees are willing and able to use it consistently."* The Competitor
Landscape asks for *"a calm product experience"* and *"a calm, simple and
approachable interface."*

Two ideas from the docs that are safe and useful in creative:

- **"Enter it once."** Information the crew records in the field (hours, notes,
  photos, work completed) gets reused for daily reports, payroll, job costing,
  billing, and customer updates, so nobody fills in the same thing twice. The
  docs call this the *"enter it once"* philosophy and use daily reporting as the
  example: the daily report builds itself out of what was already recorded,
  instead of asking the crew to write another report at the end of the day.
- **Built for subs, not adapted from software for general contractors.** The
  docs return to this on every page. Competitors were built for general
  contractors, large commercial builders, or enterprise organisations, and
  subcontractors get a version of somebody else's product.

Proof points the docs offer, all of which need Brian to confirm before they go
in an ad (see the flagged conflicts below): setup takes less than an hour, free
onboarding and training, a 100-day money-back guarantee, unlimited jobs and
employees on every plan, QuickBooks integration, flat pricing at $49 a month,
and founder-led human support.

### Never-rules

- **Never say "all-in-one."** This is his hardest rule and he stated it twice:
  *"They're an all in one solution. No, we're an all in one solution too. But
  you'll never hear me say it because all in one sounds complicated. It sounds
  like it's going to be the ever. It's going to be like this entity that comes
  into my operation and takes it over. Like, that's not us."*
- **Never write loud, feature-counting copy.** What he sees from competitors and
  refuses to do: *"I can send you ad examples on Facebook that I've literally
  been fed where these ads are doing nothing other than screaming, saying how
  many features they have."* No lists of modules, no feature totals, no
  exclamation marks, no urgency stacking.
- **Never suggest the software takes over his customer's business.** No "runs
  your business for you", no "replaces your office", no automation-takes-charge
  framing. His line is that it supports the business and the operation stays as
  it is.
- **Never imply their current way of working is stupid.** They built real
  companies on paper. The problem is the extra hours and the missing records,
  not their judgment.
- **Never claim SimplySub is a field service management platform.** The
  Competitor Landscape is explicit: *"Not built to be a comprehensive Field
  Services Management Platform such as Jobber or HouseCall Pro."*
- **Never exaggerate a capability.** Core Principals: *"Earn trust. Never
  exaggerate, fabricate, or overpromise."* If you are not certain the product
  does a thing, leave it out and ask him.
- **No em-dashes and no jargon** in anything a customer reads. Short sentences,
  everyday words.

### Tone words

From the call: **calm, assuring, flexible, simple, subtle, soft.**

The Core Principals document gives seven rules that read as a creative brief and
you should treat them that way:

1. Simplicity over enterprise. Favour simplicity over enterprise bloat.
2. Help contractors first. If a choice improves the user's experience, it wins.
3. Earn trust. Never exaggerate, fabricate, or overpromise.
4. Be practical. Every resource should be immediately useful.
5. Stay consistent. A visitor should feel every resource comes from the same
   experienced team.
6. Promote SimplySub naturally. The product supports the resource and should
   never overshadow it.
7. Build for the long term. Favour quality and maintainability over shortcuts.

### Where the brand documents and the calls disagree

Flag these to Brian rather than choosing silently. Where a customer will read
the words, **the call wins**, because Brian stated those rules about his own
advertising.

1. **"All-in-one" appears in his own documents.** Brand Bio opens with
   *"SimplySub is an all-in-one construction management platform built
   specifically for subcontractors and specialty trade contractors."*
   Competitive Differentiation closes with *"combining the breadth of an
   all-in-one construction management platform with the simplicity,
   affordability, and trade-specific focus that subcontractors need."* On the
   call he banned the phrase from advertising. Treat the documents as internal
   descriptions and keep the phrase out of every ad, headline, and script. Worth
   telling him the phrase is in his own docs, because his website may carry it
   too.
2. **The brand voice in Brand DNA is louder than the voice he asked for.**
   Brand DNA says the voice is *"straightforward, confident, and
   contractor-first"* with a personality that is *"no-nonsense, dependable, and
   efficiency-driven"*, and that it *"reinforces trust through repeated claims
   of simplicity, speed, and practical value."* Repeated claims is close to the
   feature-shouting he rejected. His words were calm, subtle, soft. Write calm
   and plain. Read "no-nonsense" as no jargon and no padding, not as forceful.
3. **The 100-day money-back guarantee is claimed twice, for two different
   companies.** Brand DNA lists it as part of SimplySub's model. The Competitor
   Landscape lists *"Strong value messaging and a 100-day money-back
   guarantee"* as a strength of Contractor Foreman. One of the two is wrong. Do
   not put the guarantee in ad copy until Brian confirms it is his.
4. **Demo-led versus purchase-led.** Brand DNA describes the model as having
   *"demo-driven conversion designed to reduce buying friction."* On the call he
   removed the demo options from the purchase landing page and asked for
   purchases only. For ads: purchase only. The demo still exists on the site,
   and if purchase volume stalls, offering the demo path again is a question for
   him, not a decision for you.
5. **Audience width.** Brand DNA describes buyers who *"value operational
   control, simplicity, speed, and cost efficiency."* The call describes a much
   narrower person: an older owner who does not want software at all. Target and
   write for the narrow version. The wider description is useful for what the
   product does, not for who the ad speaks to.
6. **Price advantage against Contractor Foreman does not exist.** His own
   Competitor Landscape lists Contractor Foreman at *"From $49/month"*, the same
   headline price as SimplySub. Never claim SimplySub is cheaper than Contractor
   Foreman. Against Buildertrend and Procore the price comparison is real, and
   the document makes it: flat $49 a month against custom pricing in the
   thousands.

### The "why people should read about us" angle

His document frames SimplySub as part of a shift that is already happening
rather than as a product launch. The parts worth using in creative:

- Subcontractors are moving off *"disconnected spreadsheets, paper forms, group
  texts, and overly complicated platforms"* toward simpler software designed
  around how they actually work.
- Specialty contractors have been underserved for years, and their only two
  options were informal tools or *"expensive software filled with features and
  complexity they may never use."* Ads can name that choice, in plain words, and
  say there is a third option.
- The story is about small and midsize subcontractors modernising. Methods that
  worked for years get harder as the company adds employees, crews, customers,
  and simultaneous projects. That is the moment of need, and it is the best hook
  territory for this audience because it is their own experience rather than a
  software pitch.
- The company's stated accomplishment: a full construction management platform
  that stays accessible to the smaller contractors the software industry
  overlooks, expanded on direct customer feedback.
- His closing line, which is the tone target for a video script: the story is
  about *"giving subcontractors access to powerful, practical technology that
  respects their time, understands their work, and helps them build
  better-organized and more profitable businesses."*

---

## 6. Competitor landscape

Source: Brian's own Competitor Landscape document, Version 1, August 2026, based
on public vendor pages reviewed 2026-08-05. It is desk research, not product
testing, and it says so. No ad libraries have been scraped for this account yet,
so you have no view of what any of these companies actually run on Meta. Say
that if he asks.

**Direct, and the document rates all three as high threat:**

| Rival | Price in his doc | Their wedge | What the document says they get wrong |
|---|---|---|---|
| **Contractor Foreman** | From $49/month | Low-price breadth for small contractors | *"Many have said the number of features included in their 'all in one' approach is daunting, creating an experience where not all features are used and the product becomes bloated."* Dense and *"less opinionated"* |
| **Knowify** | From $99/month | Job costing, QuickBooks depth, AIA billing | Financial depth is more than a smaller subcontractor needs at first. The document says do not attack their accounting depth |
| **JobTread** | Contact sales | Budget-first workflow from estimate to project financials | Broad contractor focus, so the subcontractor-specific language and workflows are open ground |

**Adjacent and enterprise:**

- **Buildertrend** (custom, demo-led pricing): mature but built around home
  builders and remodelers, so it feels heavy for a specialty sub. The document
  contrasts flat $49 a month against *"thousands of dollars per month"*, and
  claims time to adoption under an hour for SimplySub.
- **Procore** (custom pricing): the enterprise benchmark and the name buyers
  recognise. The gap is cost, implementation effort, and complexity.
  *"Many subcontractors need core visibility and control, not an enterprise
  transformation."*
- **Jobber** ($29 to $529/month billed annually): a polished field service
  platform for recurring visits. Weaker on construction-grade project costing,
  progress billing, long-running jobs, and jobsite documentation.
- **Buildxact** is listed in the adjacent tier with no profile written.

**Point solutions:** Raken (daily reports and safety, but does not own the
customer, estimate, invoice, and payment lifecycle), busybusy (GPS time and
equipment, free tier, and it becomes another login and another data handoff),
Fieldwire (free tier, Pro from $39 per user per month annually, so per-user cost
climbs with the crew, and its focus is the jobsite rather than the business).

**How the document says to compete, and it agrees with Brian's tone rules:**
do not try to win on the longest feature list. Win on subcontractor fit,
simplicity, speed to being useful, how easily the crew adopts it, payments, and
a calm product experience. Its own summary of the market gap: most platforms
force subcontractors to pick between a narrow point tool and a complicated
system designed for somebody else.

Two cautions when you use this section in copy:

- The pricing figures came off public pages on 2026-08-05 and vendors change
  them. Do not put a competitor's price in an ad.
- Naming competitors in ads invites comparison and argument, which is the
  opposite of the calm tone. Use the landscape to choose what to say about
  SimplySub, not to attack a named rival, unless Brian asks for comparison ads.

---

## 7. Creative

- **Brian makes his own content and there is a lot of it.** *"I do product
  videos, they're all published on the site, the whole gamut... We have so much
  content for ads, it's not even funny."*
- **Video first.** Daniel's guidance on the call, which Brian accepted:
  *"when you're starting out video, video is the way to go... do like 30 second,
  45 second minute long ads."* Statics are in use too, and a VSL was recommended
  for the landing page.
- **Off-limits:** loud feature-shouting, "all-in-one", anything that reads as
  complicated or as taking over the business. See section 5.
- **Image style** named in Brand DNA: photo-realistic.
- **Do not claim you watched his videos.** You can read performance per ad and
  the copy. The contents of a video are only yours to discuss once creative
  analysis has actually run for this account.

---

## 8. Operating rules agreed on the calls

1. **Kill at $300 CPA.** His stated kill band.
2. **Kill a campaign that has spent real money with no purchases.** The live
   example was the ad that had spent $730 for zero purchases, and he switched it
   off on the call: *"Is it okay for me to just like turn it off now? Yeah,
   that's fine."*
3. **Do not move a daily budget by more than 20% in a day.** Daniel's rule on
   the call: *"we don't recommend making adjustments of more than 20% per day
   because we don't want to disrupt the algorithm too much."*
4. **New ads go into the purchase-optimised campaign** (he called it the final
   product campaign). Asked whether everything should be uploaded there, he
   said: *"Yeah, that's fine."*
5. **Facebook placements for this audience.** See section 3.
6. **He is comfortable with Ada pausing** ads and campaigns that breach the CPA
   bands. That comfort is not the same as the write lane being switched on, see
   section 9.

---

## 9. What Ada must not do here

- **Do not claim you changed anything in the account.** Nothing in this file
  records a write lane being enabled for BRIAN. Until Daniel confirms the
  switches for this account, everything is a proposal: put up the full proposal,
  say plainly that it needs his approval, and never describe a change as done.
- **You cannot delete anything in an ad account, ever.** Anything that should
  stop gets paused.
- **No edits to a spent ad set or ad beyond pausing.** Never change bid
  strategy, optimisation goal, or attribution on an object that has already
  spent. Those settings are fixed at creation.
- **Campaign structure is his call, not yours.** CBO or ABO, bid strategy, and
  optimisation goal go into the proposal as choices for him to pick.
- **Do not report a purchase count as fact when it came from the pixel.** See
  section 4. The pixel has been running about 30% high.
- **Do not report on leads or demo bookings as the success metric.** Website
  purchases only.
- **Do not promise WhatsApp delivery.** He asked for it, and nothing in this
  file says the WhatsApp hook exists. Say what you can actually deliver today
  and let Daniel confirm the rest.
- **Do not blame him for the account's history.** The broken pixel setup and the
  three silent months were the previous freelancer's. He already knows.
- **Do not compare him to other clients by name.** Benchmarks are anonymous
  cohort figures only.
- **Do not use "all-in-one" or feature-shouting language**, including in
  headlines you draft for his review. This is the rule he will notice first.

---

## 10. Communication

- **Channel he asked for: WhatsApp.** *"I would prefer to use WhatsApp if you
  have a hook for WhatsApp. Yeah. Just because I've got freelancers that are on
  WhatsApp and I manage that."* He also asked for the follow-up material there:
  *"Send me anything over from WhatsApp and like I said, we'll go from there."*
  Treat WhatsApp as his stated preference and confirm with Daniel what can
  actually be sent there before promising it.
- **Recipients: Brian only.** No other names came up on either call.
- **Cadence: not agreed yet.** Nobody set a reporting rhythm on the calls. Ask
  him, and until he answers do not promise a daily or weekly report.

---

## 11. Open questions: ask at the next touchpoint

1. **Volume against efficiency.** Ten sales at $60 or twenty-five at $90, and do
   the kill bands bend when volume is scaling? Never discussed.
2. **Which competitor does he actually worry about, and why?** His document
   names Contractor Foreman, Knowify, and JobTread as the direct three, but that
   is desk research. He has never said which one he loses deals to.
3. **Reporting cadence, and whether anyone else should receive reports.**
4. **The 100-day money-back guarantee:** is it SimplySub's, or did it come from
   the Contractor Foreman research? Section 5, conflict 3.
5. **Which claims can go in ads today:** setup in under an hour, free onboarding
   and training, unlimited jobs and employees on every plan, QuickBooks
   integration. All appear in his documents and none has been verified against
   the live product.
6. **The pixel cleanup:** when does the duplicate pixel come off the landing
   page, and who implements the hashing? Until then CPA is measured on a number
   that runs high.
7. **Chargebee to Stripe:** what is the timing, and can Ada get the backend
   purchase count for reconciliation once it moves?
8. **Which destination is THE page for ads:** `lp/purchase`, `lp/core`, or the
   regular pricing page that is currently converting well.
