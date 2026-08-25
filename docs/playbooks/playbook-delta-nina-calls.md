# Playbook delta: the uncovered Nina & Daniel calls

*Extracted 2026-07-25 from the Nina/Daniel calls that `playbook-ecom.md` and `playbook-leadgen.md` did not read. Those two docs are the baseline; this doc only carries what changes, contradicts, or adds to them. Read them first.*

## Why this exists

The two playbooks were extracted from 33 transcripts and their coverage list includes **8 of the ~25 Nina & Daniel one-to-one calls**. This doc reads the other **17**, roughly 890 minutes, and it is weighted exactly where methodology lives: the two of them alone, screen-shared, arguing about one account at a time.

The headline result: the method in the playbooks is broadly right, but **one of its named diagnostic rules is falsified on tape four separate times**, three of its "open questions for Daniel" are already answered on tape, and the corpus contains a class of failure the playbooks never mention — an AI in the upload loop inventing destination URLs that then spend real money.

## Coverage / audit trail

**16 calls read** (17 attempted).

| Date | Length | Id |
|---|---|---|
| 2026-04-07 | 29 min | `01KNKBZC2GSEP3K7F9Z5HJ39Y4` |
| 2026-04-13 | 58 min | `01KP39RJ8P0J6Q93T5870WQ2N2` — **unusable** |
| 2026-04-24 | 60 min | `01KPZJD04RQG6YSGE2HTKPFCXP` |
| 2026-05-04 | 73 min | `01KQS8VHPPA90RVC4FYVHJ9PKY` |
| 2026-05-08 | 60 min | `01KR3QT0GXRMWBY50CZVSANMFQ` |
| 2026-05-15 | 48 min | `01KRNK30QSNSQ4HGB8SZ95GTRN` |
| 2026-05-18 | 20 min | `01KRXA9WXCDVPYFSV22QGKATXQ` |
| 2026-05-20 | 106 min | `01KS2A7BD93V6Z396306PVBE6P` |
| 2026-06-05 | 62 min | `01KTBNBP67KM3BC77BAT8QBDER` |
| 2026-06-08 | 67 min | `01KTKCPXP4GWJBRV1VKXZQCXY1` |
| 2026-06-12 | 61 min | `01KTXP48XVM1B3K4NN9H0APGCT` |
| 2026-06-15 | 64 min | `01KV5DHBFSBM6FDWY994CKCXB6` |
| 2026-06-19 | 53 min | `01KVFPY0V83EZ77ACAAVTY8BPS` |
| 2026-07-01 | 65 min | `01KWEPA4RR1VG8J62S2JTNATC3` |
| 2026-07-03 | 66 min | `01KWKRTXT7JNJV6BC98J9P0SFG` |
| 2026-07-06 | 59 min | `01KWVFNAZC12JB0DVJ84NV3PKA` |
| 2026-07-06 | 32 min | `01KWVFNSKPSEHDJ0GT5FSYV21B` |

**Two honesty notes on method.**

1. **2026-04-13 is gone.** Fireflies reports 58 minutes but serves a 6-second audio file and no transcript. Not a transcription failure that can be re-run: the recording itself is 97 KB. Nothing from that call is in here.
2. Of the 16 usable calls, the four shortest were read line-by-line in full; the other twelve were read through a keyword-density filter (metric, structure, and causal-reasoning vocabulary plus two lines of context either side), which compressed ~700 minutes to a readable size. That filter keeps every passage where a number, a mechanism, or a "why" appears, and drops social conversation. **It can in principle drop a methodology point made in entirely non-technical language.** Everything quoted below was read in context.

**Transcription caveats, in addition to the ones the playbooks list:** "Nina" is frequently substituted for "let me" ("Nina me see"), and the 2026-06-19 call renders long stretches of Daniel reading Ada's output aloud as unpunctuated single sentences. Quotes from that call are reproduced with their run-on structure intact rather than tidied.

---

## 1. Corrections to the existing playbooks

### 1.1 PDP view rate is not a lever. The playbook's causal rule was tested and failed, four times.

This is the most important correction in this doc, because the rule is currently stated as actionable in `playbook-ecom.md` (Step 3 and the post-click table): *"PDP view rate low because the ad points at a collection page → route to PDP instead."*

**Daniel encoded exactly that rule, then Ada disconfirmed it the same hour** (2026-05-20):

> "before we jumped on the call, I wanted to add a skill to ADA to know that **if PDP view rate goes down, it can mean that we are sending traffic somewhere else.**"

Ada's answer, read aloud minutes later:

> "here's what I found. Honest upfront: **the state learning predicted destination shifted off PDP. That's not what happened here.**" … "**92% routes to non-PDP pages, collections.** So PDP percentage we're measuring. Okay, **we need to refine the learnings.**"

**Second disconfirmation, a full 60-day analysis** (2026-06-19, Laori):

> "**routing does drive the PDP rate metric but sending more traffic to product pages lowers roas**" … "**pushing budget to products instead of collection actually lowers roas across the full account. Collection traffic out earns product traffic every quarter.**"

with the explicit instruction set that follows from it:

> "**treat PDP viewrate daily health trend as a target: yes drop.** front load budget into the cold" … "**you default to collections at best seller destinations**" … "**don't optimize for [P]DP**"

and Daniel's own restatement of the correct causal direction:

> "so we are not, so we're **rather than forcing people to look at PDPs and increase the PDP review rate that way, we're targeting people who naturally look at more PDPs.** So PDP viewrate can be an indicator of interest."

**Third disconfirmation, exogenous cause** (2026-06-12, Teethlovers). Daniel sees PDP view rate up and assumes routing:

> Daniel: "Why is our PDP view rate higher?"
> Nina: "it started going up after we started advertising limited edition drops."
> Daniel: "And we're sending them directly to the pdp."
> Nina: "**No, I mean after they came online. Not like us as advertising, but teeth lovers in general.**"

The catalogue changed, not the media buying.

**Fourth, a month-long on-site split test** (2026-06-15, Laori): *"in intelligence, there was a lower test again with collection versus pdp"* … *"if we look at the results from the entire range, it was from May 11 for more than a month"* → *"we passed the test"*, and Nina: *"for the VIVI ad, which was basically the same one, the collection page performed so well."*

Nina also supplies the confound that explains the *correlation* the playbook mistook for causation (2026-06-15):

> "what I used to do is I used to send people to PDP single bottle when I was setting up ads and currently obviously we're doing more the bottle and like the spritz situation. So I'm thinking **if the bit caps work better during the sunny days, that could mean that people are being directed to the single bottles more** and clicking more through the actual page."

i.e. PDP rate tracks *which campaign is currently winning*, which tracks *weather*, which tracks ROAS. Three-way confound, no lever.

**What to replace the rule with.** PDP view rate is a read on visitor intent and on the client's own assortment. It belongs in the daily health scan as a trend, it is legitimate evidence when comparing two ads, and it is **not** a thing to optimise by re-routing traffic. Daniel says the quiet part out loud on the same 06-19 call, about the metric that sits next to it: *"conversion. It was higher **is the symptom, not the cause.** Well, thank you."*

⚠️ Note that Daniel was still reasoning from the old rule on 2026-06-15, four days before the analysis that killed it — *"to me it seems that where we are directing the traffic correlates with performance to some degree"* — and still asking for the deep dive that then contradicted him. Treat 06-19 as the resolution.

### 1.2 The temperature/ROAS law is window-dependent, and it flips sign

`playbook-ecom.md` states it as a stable relationship: *"you can pretty much trace temperature and return on ad spend. If temperature rises, ROAS rises, if temperature drops, ROAS drops."*

2026-06-19, the same account, a fitted analysis:

> "the warmer weather points to the opposite way you think. Okay, **so your best ROAS moments are cold January**"

> "**temperature negatively correlated with roas across the full year becomes one of the strongest positive signals in this window.** Thank you. Inside summer heat helps."

> "one days are good are **within the week ripple set sitting on top of a much bigger seasonal tide that falls the other way**"

> "**Temperature isn't a fixed law.**"

and the effect is an interaction, not a main effect: *"so the trigger is **heat plus weekend**. Temperature is the strongest thing tracking daily roas in that window."*

**Rule for Ada: never fit a covariate on all history and apply the sign to now.** Fit inside the operating window, de-seasonalise, and state the window with the coefficient. This one generalises well beyond weather — it is the correct treatment of any seasonal covariate, including day-of-week, which the playbook also treats as a fixed per-account fact.

### 1.3 Break-even ROAS is not a constant. It is a function of spend.

`playbook-ecom.md` Open Question #3 asks *"What is the actual break-even ROAS input, per account?"* and treats the 3.0 / 3.3 / 1.9 spread on Teethlovers as three different bases needing reconciliation. The mechanism is stated plainly on 2026-07-01 (Laori):

> Daniel: "there was some profit here but after dropping the spend by so much, **like even here with a ROAS of 3.22, we're still not profitable.**"
> Nina: "it's 3.3. **It's not three anymore, it's 3.3 now.**"
> Daniel: "because here we had a Ross of **3.05 and we were break even on the day. With a higher spend.**"
> Nina: "if we would do 2000 on Meta and around 200 on Google, we would need 3.3."

**Because fixed OPEX is spread over fewer orders, cutting spend raises the required ROAS.** So break-even ROAS is `f(spend, fixed OPEX, variable margin)` and it moves every time you touch the budget. The three numbers in the playbook are not three competing estimates; at least two of them are the same function evaluated at different spend levels.

This also makes the playbook's Open Question #2 ("is the trigger contribution-margin-positive or marginal-ROAS-above-break-even?") partly a non-question: they are the same inequality, and the marginal form is the one that stays valid when spend moves.

### 1.4 Nina's fixed-cost objection is the sharpest analytical point in the corpus and the playbook does not record it

Stella steers Laori on a fixed ratio: ad spend should be 30% of revenue. Daniel identifies it correctly (2026-06-15): *"Well, this is the **reverse roas**. So it's just, it's the same formula but upside down."* Nina then makes the argument that follows:

> "**3x ROAS doesn't make her profitable.** It depends on how much we're spending and how much she makes." … "**I think it should be even higher because the revenue is lower. So the 30 is not even enough.**"

She is right, and it is the exact inverse of Daniel's scale-into-profit argument from the same equation: a constant spend-to-revenue ratio is only equivalent to break-even when fixed costs are zero, so **as revenue falls the required ratio must tighten.** The playbook records Nina as the cautious one on scale pacing (Disagreement #3) without recording that she is reasoning from the correct model.

### 1.5 The contribution-margin doctrine is six weeks older than the playbook dates it, and Nina disputed it on the spot

`playbook-ecom.md` attributes *"the biggest doctrinal shift in the corpus"* to Teethlovers on 2026-07-23, with Fable computing marginal break-even on 07-24. It was derived by hand on **Laori, 2026-06-12**:

> "the daily operating expenses of running the business for Lowery are about €2,000... So if my logic is correct and we end the day on, let's say a loss of €1300, **it means that we generated about €700 worth of margin** if we just look at the business without the opex. **But this already includes the marketing budget.**"
> "wouldn't it make sense for us to have spent more on Facebook rather than less? Because **to make up for the entire €2,000 loss, we would have had to generate three times as much margin, which would then at the same roas would mean that spending three times as much would have made us break even.**"

Nina disagreed immediately, and substantively:

> Nina: "**I don't think we will be able to spend so much more to be profitable.** I feel like it will be more of a pulling back spend and doing the bit caps."
> Daniel: "if we pull back spend too much, then it doesn't matter what we do, we won't be profitable on the day. And **this is a strategic question to discuss with Stella.**"

And Daniel then reframes it as a client decision, not a media-buying one — which the playbook does not capture:

> "are we willing to take a loss on the bad days to make sure that we are making more profit on the good ones **or is the strategy now for us to figure out what do we do on cold rainy days? Because it feels like we don't have a strategy for the cold rainy days.**"

**The natural experiment ran, and it went against the client's instinct** (2026-06-15): *"we turned this spend down. But Roas also didn't go up. So what ended up happening? We turned spend down. **Roas became even worse.**"* Reported honestly: he contradicts himself later in the same call (*"since we dropped spend ROAS seems to have improved"*, then *"the profitability improve since we turned down ad spend... I mean not really"*), and Nina lands it at *"it improved compared to the previous days that weren't as good."* The result is real but weak.

### 1.6 The €1,600 reframe: contribution margin as a client-communication device

Distinct from the scale trigger, and not in either playbook. 2026-06-15, Laori:

> "with salaries and rent and office everything, €600 per day to run the business" … "**if at the end of the day we're losing €1,600, then the marketing paid for itself.** If we are losing less than €1600 or making money, then it means that the marketing spend generated enough margin to offset the operating expenses."
> "so I think **this is how we can also reframe the conversation with Stella.** It's not like we caused the business to lose €1,600 per day, but rather here's the additional layer."

**Encodable: "loss on the day ≤ fixed OPEX" means the ads are self-funding.** It is the same arithmetic as the scale trigger pointed at the client's anxiety instead of at the budget.

### 1.7 Bid-cap step size is 10% in practice, not the playbook's universal 20%

Open Question #9 assumes ~20% everywhere. 2026-06-05, Daniel working live on Brain.fm bid caps: *"Let's go, let's go up it by 10%"* … *"let's go down to 34 to 10% increments."* Then he asks Nina for the received wisdom and gets a three-way split:

> Daniel: "are you aware of any rules or best practices as to like bit cap adjustment? Is it 10%? Is it 20%?"
> Nina: "**Most people are saying 20%**, unless it's like not spending at all and you don't really care, so then you can do whatever. But **the budget, they're saying you can do like even 50 or 60% more.**"
> Daniel: "Okay. **So budgets don't matter for the bit caps.**"

Three steps for three levers, not one number: their own bid-cap practice ±10%, industry bid-cap convention 20%, budget 50–60%.

Same call adds the **course-correction rule** the playbook lacks: *"I wonder whether we should implement this as a rule for ADA to flag that **when the cost per result of the trailing seven days is higher than we want it to be, that we course correct the bit caps** a little bit"* — and the opposite case, which is the one people forget: an ad set at $12 CPA under a $35 bid cap is *underbidding*, so raise the cap to buy volume.

### 1.8 tROAS has a mechanism, and the test that condemned it was invalid

`playbook-ecom.md` records only the verdict: *"tROAS bidding — tested, hated."* 2026-06-05 supplies both the signature and the caveat:

> "First of all, Target Roas, **it has twice the cp, twice the cpm.**"
> Nina: "and also like the **CPC is through the roof.**"

with CTR high — so tROAS was bidding up the auction, not failing to find clicks. And the structure was contaminated:

> "I think this may be a structure question, because **here we're testing Target roas and we're testing asc**" → "can you please set up another Target Draws campaign... and then just do a 1:1 test because like here we've mixed. **We've mixed this.**"

So the standing "tROAS is horrible" verdict rests on at least one test that mixed two bid technologies in one campaign. Worth re-running cleanly before Ada treats it as settled.

### 1.9 Two smaller corrections

- **Related Media re-attaches on every duplication.** The playbook's fix is *"pass an explicit empty `related_media` spec at creation."* Nina, 2026-06-15: *"**it does it every time you duplicate something or add something new.**"* The fix has to run on every duplicate, not once at creation. Symptom the client reports is cropped feed ads.
- **Audience-segment breakdowns: the playbook says the API can't; Daniel reads them anyway.** `playbook-ecom.md` records *"New-customer CPA via the API — not available"* (06-01). On 2026-06-08 Daniel does the read: *"one more breakdown that we need to start looking at is **breaking things down by audience segments** because this looks like the back end stock is spending the majority on new audiences... This is supposed to be an ad that is bottom of the funnel but **it's trying to spend on top of funnel.**"* Either the capability differs by surface or one of the two statements is wrong. Worth settling, because *funnel stage of the creative vs audience segment it actually reaches* is a good check.

---

## 2. Open questions the playbooks list that are already answered on tape

### 2.1 "Which ROAS is the target?" — answered 2026-05-08, and the mismatch is deliberate

The playbooks carry this as Disagreement #1 *and* Open Question #1, unresolved as of 07-23. The origin is on tape ten weeks earlier, Teethlovers:

> "I had a chat with Alex and whatever his name is, and **we looked at their unit economics together. In order to be profitable, they need a roas of slightly below 3.** Like 2.9 something something. So we might as well say 3. **But it's a 3x ROAS sort of like across the board looking at, like including klaviyo, looking at everything.**"
> "But when we're steering, I think it's easier for us to **steer towards the 3x roas, just like in platform.** I think it's just going to help us be a little bit more nimble and a little bit more aggressive with how we approach the ad account."

So: **the 3x is an all-channel blended break-even, knowingly re-used as an in-platform steering number, traded for operational speed.** Nina treats it as settled twelve days later — *"we need ROAS 3 in platform"* (05-20) — and Daniel restates it on 06-08: *"the goal for them is a 3x in platform."*

That means Vanessa's 07-23 objection is arithmetically correct and Daniel's answer is "in-platform, on purpose". **For Ada: target value and the attribution model it is measured in are two separate fields, and on this account they are deliberately mismatched. Do not silently reconcile them, and do not present the 3x as derived from in-platform data.**

### 2.2 "What's the fallback when a client states no target?" — there is a live interrogation script

Open Question #4 asks what to do without a target CPA. Daniel's actual move is to derive it by interrogating the client's own P&L until the goal either holds up or collapses (2026-04-24, Faircato):

> "their strategy is to get 80,000 in revenue, and I asked them, **what are you willing to pay for it? They're like €80,000.** So a 1x raw US, they would be happy."
> "so what's your income right now? They're like, yeah, well, €35,000. I was like, okay, so and what's your margin? They're like 10%. **Okay, so like the people are buying on your platform products worth 350,000, right? They're like, no, €35,000.** Wait, so and your margin on that is 10%. She's like, yeah. **So your income is three and a half thousand euros.** She's like, yeah."

The goal itself gets audited before any metric does. `playbook-ecom.md` Step 0 asks for the goal; it never checks whether the goal is coherent. Companion move, 2026-05-08 (forpeople): back-calculate the spend the goal requires — *"if the goal is €50,000 of revenue... **spending €100 a day or €120 a day, we will not be going to 50,000 revenue.**"*

### 2.3 "Is 20% the universal scale step?" — see §1.7. Answered: no, three different steps.

---

## 3. New checks and rules

### 3.1 Measurement integrity

**The agent must never invent a destination, and every URL must be resolved before publish.** This is the single most consequential new rule in the corpus, and it fired twice on two different accounts.

2026-07-01, Laori:
> "is it possible that we're sending people to a 404?" … "Apparently we do because **this data is coming straight from meta.**" … "**What if ADA hallucinated this URL when uploading some of the Stella ads?**" … "I don't think this landing page ever existed. **I think it's a figment of Ada's imagination.**" … "**We've spent €600 on this. But it had the best roas.**" Nina: "Yes, exactly. That's so bad."

2026-07-06, press — a product page reading ROAS 0.24:
> "**Did ADA hallucinate the landing page again?**" Nina: "**this has been happening now quite a lot.**"
> "this is absolutely unacceptable. Can you please build into the upload flow that **every single time when ADA is deciding whether to use a URL or not, that you actually visit the URL and see if it's a 404 or not.** And then also **make sure that Ada never suggests any landing pages herself** because we've been sending traffic to a landing page for press that doesn't exist."

Note the trap inside the trap: **the broken destination showed the best ROAS in the account.** A dead URL does not present as zero; it presents as a tiny denominator with noisy attribution on top, which reads as a winner. Any "promote your top ad" logic will promote it.

**Flat upstream + a cliff at a specific hour means the tracking broke, not demand.** 2026-06-08, Nine Pine:

> "ADA is like, oh, yeah, it was most likely an attribution issue. I was like, ada, shut the up. You cannot say things like that. And then I go into the terminal and she's like, **no, no, that's actually an attribution issue because the number of checkouts and add to cart stay the same. But then after 2 o'clock the number of purchases just went down.**"
> "**Ada by the way has access to hourly breakdowns which you cannot have in meta.**"

Two things ride on this. The **shape** of the change is the discriminator — 2026-05-20: *"Could he maybe check on an hourly breakdown when that actually happened? **Was it a gradual decline or a sharp drop off?**"* A cliff implicates instrumentation, site, or config; a slope implicates market, fatigue, or mix. The playbooks date change points to the day, which cannot make this distinction. And the **hourly breakdown is API-only**, which is a real edge for any tooling built on the API.

**Before blaming an ad, check whether the client is running an on-site test.** 2026-05-20, Teethlovers — two ads pointing at the *same* landing page, PDP view rate double on one:

> "were we sending Vivie authority drops to the same landing page as Dirk Testimonial drops?" — "Yes." — "See now this doesn't line up... **why does one have a PDP viewer that's double? I mean this makes no sense whatsoever.**"

Cause found by going to look: *"Do we have any active test? Super Smile Drops Test Zen started yesterday. **Checkout test that started on the 15th.**"* … *"okay, test badges. Trust Badge one, Trust Badge two."* Client-side split tests and personalisations divide traffic underneath your ads and corrupt every ad-level funnel comparison. And they persist: 2026-07-01, *"Bestseller AB is not doing well" / "that was just a B test" / "**no, I think that's actually being used by some of the ads now**"* → *"Is there a permanent intelligence redirect?"*

**Out of stock is invisible, because the PDP redirects.** 2026-05-20:

> Nina: "You can see on the website if it shows that they're out of stock."
> Daniel: "**Well, we can't really because it redirects automatically.**"
> Nina: "**What if you check like a big larger pack? Because this is only one pack.**"
> Daniel: "Oh, smart."

Standing instruction from 2026-05-08: *"can you please also **check the PDPs and see whether everything is in stock and everything is orderable**?"* A reachability check answers "does the page load", not "can it be bought", and those come apart exactly when it matters.

**Survey-based attribution cannot be compared across periods without normalising response rate.** 2026-06-19, Laori. Daniel computes survey-attributed ROAS for June '25 (50k/89k = 0.56) against the last 30 days (65k/99k = 0.65), then catches it:

> "Oh, but it's also, I mean **response rate.** One sec. Response rate last 30 days **52%**."
> Nina: "so if we take just last year, response rate for that question was **27%**. Just saying."

Roughly a 2x difference in response rate across the two periods being compared. Same call, a second confound: *"and we applied the segment so we cannot compare the data."*

**Dual-pixel consent configuration drifts attribution, and the change date is not the pixel date.** 2026-06-19: the Meta-vs-Triple-Whale discrepancy *flipped sign* and widened from January. The pixel switch was in October, so *"it's not a pixel issue"* by date — then the actual hypothesis:

> "**The second pixel doesn't consider consent. The first pixel does consider consent.**" … "but **maybe we configured this one to consider consent in February and then it started reporting less.**"

Check per-dataset consent settings *and the dates they changed*, not just which pixel is attached. Elevar is where this lives. A bonus from the same call that contradicts a standing belief: *"wait, so they do see event match quality... **my meta thing said that it's impossible.**"* → EMQ is visible through Elevar, and Daniel saves it as an Ada feature on the spot: *"ADA event match quality monitoring or Magic audit."*

**When a profit series changes level, check whether the client changed their cost inputs.** 2026-07-06, Teethlovers:

> "the reason why these days are not looking as great starting from here [is] because **they've also adjusted their OPEX calculation.**"
> Nina: "I know because **they were profitable until they changed it.**"

Any profit-based dashboard inherits the client's accounting assumptions, and those move silently. This is a hard one for Guard: the metric moved and nothing about the ads did.

**Meta re-compresses uploads, so assets fetched back are the degraded copy.** 2026-05-08: *"Meta is compressing the files after we upload them and when we are asking Meta to give us the files back, **we're getting the version that they have.**"* Any creative-analysis pipeline that re-downloads from Meta is scoring a worse image than the one that ran.

**Pixel proliferation.** 2026-07-01, Slumber: *"yesterday he created two new ad accounts with two new pixels and now we have four or five."* Named as a mess to consolidate in Elevar, not yet solved.

### 3.2 Diagnosis

**Measure landing-page conversion rate in Shopify, filtered to paid, with bots removed.** 2026-07-01, worked live:

> "we have landing pages sessions by landing pages would work reach checkout" … "**remove the bots**" … "conversion rate per landing page" … "**per utm source**" … "ATM source parameter is Facebook and now it allows us to do that. Okay so herbal spritz 3.6%."

And the trap that comes with it, caught immediately: *"it's weird that the alleproducta landing page seems to have the very best conversion rate. 9.8%"* → Nina: *"**maybe that's some linked somewhere in the email.**"* Un-segmented landing-page CVR ranks your email traffic at the top. This is the correct implementation of the LP analysis both playbooks keep reaching for.

**Judge an LP test on revenue per visitor, not conversion rate.** 2026-05-04, forpeople: *"conversion rate down, AOV up"* → *"so this is getting **revenue per visitor.** I mean, it's close."* With a causal read for why the higher-AOV page loses CVR: *"if the AOV is less than what we are like sort of like asking them to do, it's basically **they're leaving the page and then looking for something else.**"* On 2026-04-24 the metric added to the Intelligems test is add-to-cart rate as the secondary.

**Cross-funnel reallocation has an arithmetic threshold.** 2026-05-04, JVA:

> "over the last seven days, here we're paying **22 per lead**, and here we're paying **580**. So if the conversion rate here is less than 4... less than 25%... no, **75% worse**, then it's better for us to allocate the spend in here."

Compare the CPL ratio to the downstream conversion-rate ratio; the cheap funnel wins unless it converts worse than the ratio.

**Account AOV moves are usually product-mix moves. Check spend share by product line first.** 2026-05-08, Laori: *"the AOV went down... last 30 days it was almost €60 on that campaign. And now it's 45.4"* → *"the glitter spritz got a lot more spend in the last few days"* → *"ROAS is 1.8, while all the others are like at least 2.3."* Daniel's framing: *"the drinks behave sometimes like their own businesses almost."*

**Never compare CPA across things with different AOV.** 2026-06-12: *"because looking at CPA at a higher aov, we can't. Like **we were comparing the rest, like the wrong** [thing]."* Use ROAS when AOV differs between the compared units. This is the operational corollary of the playbook's *"measuring cost per acquisition doesn't really make sense, because we're willing to spend more on a customer who is spending more."*

**Compare CPM levels across your own portfolio to find a structurally penalised account.** The playbook's Step 11b uses portfolio CPM to separate auction-wide moves from account-specific ones — a *trend* check. 2026-05-20 is the *level* check:

> "Why does tea lovers have a CPM that is half of four people?" … "per click the last seven days, **cost per landing page view, they're paying two euros. Way, way, way too much.**"
> Nina: "**Are they flagged as a health pixel?**"

Named candidate cause, and a named remedy under consideration (new ad account). Your own portfolio is the benchmark for whether an account is overpaying at rest, which no single-account tool can do.

**Format mix vs format performance.** 2026-05-20, Laori. Ada reports video at **93% of ad spend**, then:

> "**nearly every static ad outperforms the video.** The Daniel whoop static, weight loss static one basic pitch set family **all converted 5 to 10% while most video** set" → "Okay, I mean let's do, let's do **100 statics.**"

A large gap between where spend goes by format and where results come from by format is a cheap standing account-level finding. The playbook has "statics first for speed" as a production principle; this is the audit.

**Rejection forensics start at the landing page, not the ad.** 2026-06-12, Slumber — one ad in a batch approved, two rejected:

> "Why is one approved but the other isn't?" … "Yeah, it's cannabis. **It is cannabis.**" … "**View page Source.** Let's see." … "also walk website or any [T]HC content" … "check ads for THC" … "direct landing page"

Identical-looking creatives differ because their destinations differ. The playbook's rejection path is dataset flags → brand-safety domains; add "scan the destination page content" ahead of both for content-policy rejections. This is also the origin of the internal QC skill the playbook lists as a proposal.

**Verify a partner's stated A/B result yourself, and use revenue per send.** 2026-07-06, Klaviyo send-day test. Nina relays the client's read; Daniel: *"**I don't trust Anna. So let's double check.**"* Then: *"when we send campaigns on a Friday or Sunday, which perform better if we look at the **revenue per email sent**"* → *"18 divided by 14. So it's a **28% improvement**"* → *"open rate is the same. Click rate is a little bit lower here, more purchases"* → *"**so the conversion rate on the Friday was just much better.**"* Note the shape: the winner lost on click rate. Judging that test on engagement would have picked the loser.

**When performance regresses to a level you previously fixed, ask whether a known unlock was reverted.** 2026-06-05, Brain.fm, after moving off the quiz funnels and back again:

> "Since we switched over to the funnel. Surprise, surprise. Who would have thought?" … "**But this also makes me wonder why we didn't flag this. Because technically, we knew.**"

Same call names the design error that made the original result unreadable: the funnel switch and the $1-for-30-days offer shipped together in January — *"Adam was like super skeptical which one worked better. And to be fair, I was too."*

### 3.3 Economics and structure

**Price-ladder gaps are a post-click cause that is neither page nor creative.** 2026-05-20, forpeople: *"they have like, literally **9.99 or 60. Like, there's almost no in between**"* → build a €30–40 bundle; and build one around the product people actually arrive for, found through customer interviews: *"they figured through their interviews that **people are finding them through their sunscreen**"* → *"I asked them to make a bundle... because otherwise, again, it's only €10."*

**Launch comparisons are confounded by available stock, and bundle share is the discriminator.** 2026-06-12, Laori limited editions. Stella called a launch a flop on quantity; the data disagreed:

> Nina: "just looking at Shopify data, **she sold more current limited editions than like the past ones**" … "I mean it was [a flop] because she still has a lot of stock but **she had a lot less of the first limited editions.**"
> Daniel: "one thing that stands out immediately is look at the **ratio of bundle sales to single sales.** So here on the Don't Be a Lady, be a legend, **€60,000 of the revenue came from bundles. In all the other top performing limited editions, most of the revenue came from single units.**"
> Nina's cause: "because this one was paired with Amalfi... and it's the same one that Vivi is showing in the ranking ad."

**Bid caps as a deliberate demand-follower on volatile accounts.** `playbook-ecom.md` records bid caps as *"by design volatile"* and therefore wrong for a stable base layer. On a weather-driven account the volatility is the point (2026-06-08):

> "I think we need a lot more reliance on bitcap that **our spend moves even further with temperature** because she's losing too much money." … "during these days ideally we should spend a lot, a lot less and then just **have the bit caps running at the minimum.**"
> "could you please think about like how would you structure the account to **reduce risk** even further?"

With a design criterion the playbook lacks (2026-06-12): *"in the bit cap setup, I think one of the things to look out for would be **how fast does it also scale up?** Because for every day where we're losing money here, we need to make it make up for that on the other end."* Both directions of latency matter, not just the ceiling.

**The graveyard bid cap was Nina's idea, 2026-06-12.** The playbook credits it to Daniel describing a standing system to Audibene on 07-21. Origin:

> Nina: "I'm thinking, what do you think about **another beat cap, but a lot lower bits and just filling it up with everything that like lost momentum or never actually worked.**"
> Daniel: "**Like a graveyard, graveyard, graveyard bit cap.** Like it. You can try."

And it has a political function the playbook does not mention (2026-06-05, on the client's own ads): *"I think like this is like an **ego saving thing** for them above everything else. So they're like, yeah, but we're investing so much money into this. It's like, okay, yeah, let's let it compete."* … *"**the bit cap is also where Jack's ads go to die.**"* Nina: *"That's the graveyard."* Demotion lets you avoid the fight that killing would start.

**Ad-account continuity can fail through the client's corporate structure.** 2026-05-04, press:

> "our entire ad account for press is going to be blacklisted because the reason why they're switching to a new company is also for fundraising and financial reasons. And now the financial control of the old company is on someone else. **This means that if the other person decides not to pay the meta invoice, then the ad account will be** [disabled]."

Pairs with the playbook's 16-days-past-due / `ar@meta.com` note, but the cause here is a third party with no incentive to pay — and the same call finds the migration blocker: **a Klaviyo account can only be connected to one ad account**, so audiences do not come with you.

**Aging accounts start rejecting ads that used to run.** 2026-07-06: *"we desperately need it [a new ad account] because it's like just **rejecting old ads that used to perform.**"*

**Google audit items not in either playbook.**
- **Conversion counting set to "every" instead of "one"** — 7 add-to-carts from 1 impression. *"they're not counting unique, they're counting everyone"*; the client's reaction: *"why is that bad?"*
- **Search term → ad → final URL mismatch.** Keywords for polo shirts, the ad group's single ad routes to jackets, and the destination carries the query as a param. Audit is per-ad-group: does the landing URL match the intent the keywords bought?
- **Bidding on "new" while selling second-hand** — keyword/offer contradiction.
- **50% search impression share as headroom** → push spend (2026-05-08, Teethlovers).

### 3.4 Client handling

- **"What would you want me to deprioritise?"** — the move when a client asks for two contradictory targets at once (2026-06-08, Brain.fm asking for CPA €30→25 *and* more testing): *"oh, we can absolutely spend some more. **What target CPA would you want us to go with?** Because you said that the target CPA should go down to 25, where the testing is going to be higher. Like, **how much leeway do we have here?**"* Makes the trade-off theirs, and *"it also gives them sort of like the, like, oh, yeah, we listen to them."*
- **Do not steer a client toward a metric that would hurt you.** 2026-05-04, Slumber: *"Vanessa, can you please just double check and say whether CPA in Meta works? **Don't mention nCPA.**"* … *"**we don't want him to even think in that direction.**"* Same family as the playbook's hook-rate flattery passage: the house style includes controlling which metric the counterparty optimises for. Ada inherits this whether or not anyone decides it should.
- **Don't correct a client's memory in your own favour without checking the tape.** 2026-05-04: Daniel is sure Adam agreed to more Spanish ads. Nina: *"**you wrote that in his summary then after your call. So it's not like he said it.**"*
- **Some campaigns stay alive for emotional reasons and that is a legitimate reason to throttle instead of kill.** 2026-06-15, JVA scaled to €50/day rather than off: *"because then it would be sort of **giving up on that part of the business.** And I don't think that **emotionally they're ready** yet."*
- **Ada must not speculate about causes to a client.** 2026-06-08: *"ADA is like, oh, yeah, it was most likely an attribution issue. I was like, **ada, shut the up. You cannot say things like that.**"* She turned out to be right, which does not change the rule. This is the same discipline as `src/lib/guard/checks.ts` already encodes — *"Guard never asserts anything it cannot evidence"* — and it now has a real incident behind it.
- **"Keep non-performing assets running to generate learnings"** (Rebecca, Sweet Spot, 2026-04-24) — Daniel disagrees and stays silent: *"I just had to shut up and not tell her mean things on the call."* Belongs in the distrust table.

---

## 4. What I would change in the Guard checks engine

The dry-run spec in `ada-guard-deep-dive.md` and the rules in `src/lib/guard/checks.ts` are unaffected in their shape. Four concrete additions fall out of the above, all cheap and all binary or near-binary:

1. **Destination resolution.** For every active ad, resolve the destination URL and alert on a 404 or a redirect to an unexpected host. Guard's planned website-downtime check watches whether the site is up; this watches whether *this ad's page exists*, which is a different failure and the one that actually happened twice. Reds here are Meta-reported-plus-one-HTTP-fetch, so they meet the v1 "binary facts only" bar.
2. **Buyability, not just reachability.** On ecom destinations, detect the out-of-stock redirect. The larger-pack trick is the manual version; programmatically it is "the URL in the ad 302s to a different product or a collection".
3. **Flat-upstream / hourly-cliff discriminator.** When conversions fall but add-to-cart and checkout hold, and the drop localises to an hour, that is a tracking break and should be worded as one. This is the highest-value statistical check in the corpus and it needs hourly insights, which the API has and Ads Manager does not.
4. **Do not promote a suspicious winner.** Anything that ranks or promotes a top performer must first confirm the destination resolves and the result count clears a floor. The hallucinated Laori URL had the best ROAS in the account on €600 of spend.

And one thing to *remove* from the roadmap's assumptions: any Guard copy that tells an owner their PDP view rate is low and they should point ads at product pages. On the account where that was measured, it costs money.

---

## 5. Still open after this pass

1. **Does Meta honour ad-set minimum spend inside a CBO?** Unchanged from the playbook's Open Question #5 — nothing in these 16 calls settles it. Still the highest-value thing the dry-run could measure.
2. **Why did cutting spend not raise ROAS on Laori?** The 06-15 evidence is real but self-contradictory on tape, and it is the crux of the Daniel/Nina scale disagreement. It is answerable from the data they already have.
3. **Is the audience-segment breakdown available or not?** Two flatly opposed statements 7 days apart (§1.9).
4. **What is the correct PDP-view-rate story?** "Indicator of intent" is established; the *mechanism* linking assortment, destination mix, weather and ROAS is sketched by Nina and never verified. Daniel asked for that exploration on 06-15 and it was deprioritised (*"I don't think I'll have time to be honest"*).
5. **Dashboard vs Ads Manager ROAS disagree** (2.37 vs 2.59, 2026-06-08; and the Triple Whale ad-spend gap on 07-01 where the same view rendered differently for each of them). Noticed twice, chased neither time.
6. **Was the tROAS verdict ever re-tested cleanly?** See §1.8.
