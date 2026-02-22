---
name: creative-qa
description: "Quality assurance checklist for ad creatives before launch"
tags: [advertising, qa, quality, review]
---

# Creative QA Skill

Comprehensive quality assurance methodology for ad creatives. Use this to validate briefs, scripts, concepts, and hooks before they go to production or launch.

## QA Philosophy

- Focus on preventing revision loops, not finding fault
- Every issue flagged must have a specific fix attached
- Reference the source of each rule (client feedback, compliance policy, best practice)
- Celebrate clean work - do not invent problems
- Catch issues before the client does

## Full Brief QA Checklist

### Section 1: Visual Direction Check

| Check | Criteria | Pass/Fail |
|-------|----------|-----------|
| Background | Clean, uncluttered, matches brand aesthetic | |
| Lighting | Natural or on-brand, consistent across scenes | |
| Product visibility | Product clearly shown per dial settings | |
| Brand colors | Exact match to brand guidelines (not "close enough") | |
| Props/environment | Appropriate for brand and target audience | |
| Client-specific rules | Checked against client feedback history | |

### Section 2: Copy Review Criteria

| Check | Criteria |
|-------|----------|
| Filler words | No banned filler words (check client-specific list) |
| Text overlay length | Max 5 words per screen for video overlays |
| Terminology accuracy | Product names, claims match legal/brand guidelines |
| Speakability | Script sounds natural when read aloud |
| Tone alignment | Matches brand voice and target audience |
| One idea per ad | Script focuses on a single angle, not trying to say everything |
| Benefits over features | Leading with what the customer gets, not product specs |
| CTA clarity | Clear, specific call to action present |

#### Speakability Test

Read every script line aloud. Check for:
- Can the line be spoken naturally in one breath?
- Does it sound like how a real person talks?
- Are there awkward word combinations or tongue twisters?
- Does the pacing feel natural at speaking speed?
- For hooks: Can you deliver the hook in under 3 seconds?

#### Filler Word Watch List (Common)

Remove or replace these unless they serve a specific natural delivery purpose:
- "actually" (unless used for emphasis in discovery narrative)
- "basically" / "essentially"
- "really" / "very"
- "just" (when used as filler, not meaning "only")
- "kind of" / "sort of"
- "you know"
- Language-specific fillers (e.g., German: "mal," "eigentlich," "halt," "eben")

### Section 3: Compliance Check

Run against the meta-ads-compliance skill. Key checks:

| Check | Criteria |
|-------|----------|
| Personal attributes | No direct assertions about viewer's condition |
| Health claims | No "miracle," "cure," "guaranteed" language |
| Weight loss | No before/after body images, no specific claims |
| Financial claims | No income guarantees |
| Before/after | Realistic results, disclaimers included |
| Disclaimers present | FDA, results-may-vary, etc. where required |
| Text in images | Under 20% for thumbnails/previews |
| Landing page match | Ad claims match landing page content |

### Section 4: Technical Specs Check

| Check | Criteria |
|-------|----------|
| All required sections | Brief has all mandatory sections filled |
| Brief ID format | Follows naming convention |
| Language consistency | Script language matches specified language throughout |
| Editor brief language | Editor instructions are in English |
| Format specified | Aspect ratios listed (9:16, 4:5, 1:1, etc.) |
| Duration specified | Target length matches script timing |
| Hook count | At least 3 hook variants included |
| B-roll shot list | Complete with priorities noted |
| File naming convention | Creator knows how to name deliverables |

### Section 5: Dial Alignment Check

For each dial setting in the brief, verify content matches the value:

| Dial | Check |
|------|-------|
| Authenticity 0.7+ | No discount codes, no explicit pricing, discovery narrative, soft/no CTA |
| Authenticity 0-0.3 | Clear pricing, prominent CTA, brand mentions, benefit stacking |
| DR Intensity 0.7+ | Urgency present, strong CTA, scarcity elements |
| DR Intensity 0-0.3 | No hard sell, awareness-focused, subtle CTA |
| Product Clarity 0.7+ | Product clearly visible, features shown |
| Product Clarity 0-0.3 | Lifestyle focus, product is secondary |
| Hook Pre-qual 0.7+ | Hook names audience/problem/product directly |
| Hook Pre-qual 0-0.3 | Universal pattern interrupt, no product in hook |

**Common dial mismatches to flag:**
- Authenticity at 0.8 but script has explicit discount code
- DR intensity at 0.3 but CTA says "Buy now! Limited offer!"
- Product clarity at 0.2 but product is hero of every scene
- Hook pre-qualification at 0.9 but hook is a generic pattern interrupt

### Section 6: Red Flag Scan

These items are likely to cause immediate rejection or revision:

- [ ] No competitor logos visible in any shot
- [ ] No unauthorized music or copyrighted content
- [ ] No claims that cannot be substantiated
- [ ] No language that violates platform policies
- [ ] No visual elements that conflict with brand guidelines
- [ ] No all-caps text (unless brand style)
- [ ] No misleading UI elements (fake buttons, fake notifications)
- [ ] Product shown accurately (not misleading about size/contents)

## Concept QA (Quick Check)

For validating concepts before developing into full briefs:

1. **Angle alignment** - Does the angle fit the client's strategy and brand?
2. **Hook types** - Do the hooks align with what has been performing?
3. **Avoids failures** - Does it avoid patterns that have underperformed?
4. **Production feasibility** - Is the production complexity within constraints?
5. **No red flags** - Any obvious compliance or brand issues?

## Script/Copy QA

For validating script and copy elements:

1. **Filler word scan** - Check against banned word list
2. **Text overlay word count** - Max 5 words per overlay
3. **Legal terminology** - All product names and claims accurate
4. **Speakability** - Every line passes the read-aloud test
5. **Tone alignment** - Matches brand voice
6. **Brand voice consistency** - Same voice throughout, no jarring shifts

## Hook QA

For validating hook variants:

1. **3-second test** - Can you deliver the hook in 3 seconds?
2. **Dial alignment** - Matches hook_prequalification and authenticity settings
3. **Red flag check** - No compliance issues in the hook itself
4. **Performance alignment** - Hook type matches what has been working
5. **Differentiation** - Each hook variant is genuinely different (different angle, structure, or emotion)

Rate each hook:
- READY: Passes all checks, ship it
- TWEAK NEEDED: Minor fixes, quick turnaround
- REWORK: Fundamental issues, needs new approach

## QA Report Format

When presenting QA findings, use this structure:

```
QA Report: [Brief/Concept ID]
Client: [Client Name]
Validated Against: [X] rules
Result: PASS / PASS WITH NOTES / NEEDS REVISION

Issues Found:
| # | Category | Issue | Source | Suggested Fix |
|---|----------|-------|--------|---------------|
| 1 | Copy | Filler word in Hook 2 | Best practices | Remove the word |
| 2 | Compliance | Health claim too strong | Meta policy | Soften to "may help" |

Passed Checks:
- Legal terminology correct
- Brand colors compliant
- Dial alignment verified
- All technical specs present

Client Would Likely Say:
[Predict specific feedback based on known client patterns]
```

## Common Issues and Fixes

| Issue | Category | Fix |
|-------|----------|-----|
| Script sounds robotic | Copy | Rewrite in conversational tone, read aloud |
| Too many messages in one ad | Copy | Pick ONE angle, remove the rest |
| Hook is generic | Copy | Add specificity, use numbers or concrete details |
| Product not visible enough | Visual | Add product shots per product_clarity dial |
| Background is distracting | Visual | Simplify, use clean/neutral backdrop |
| Missing disclaimer | Compliance | Add required disclaimer text |
| Script too long for duration | Technical | Cut to fit, prioritize hook and CTA |
| No B-roll shot list | Technical | Add specific shots with priorities |
| Hooks too similar | Creative | Ensure each hook uses a different framework (pattern interrupt, curiosity, social proof) |
| CTA missing or weak | Copy | Add clear, specific call to action matching DR intensity dial |

## Post-Launch QA

After ads are live, monitor these in the first 24-48 hours:

- [ ] Ad approved by Meta (not in review or rejected)
- [ ] Tracking firing correctly (check Events Manager)
- [ ] Landing page loads correctly on mobile and desktop
- [ ] Correct audience targeted (check ad set settings)
- [ ] Budget allocated as intended
- [ ] All placements showing (not stuck on one placement)
- [ ] No obvious performance anomalies in first data
