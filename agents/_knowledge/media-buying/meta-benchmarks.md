# Meta Ads Benchmarks by Vertical

Reference benchmarks for Ada. IMPORTANT: Account-specific historical data always overrides these generic benchmarks. Use these only when account history is unavailable or as a sanity check.

---

## Universal Metrics

### Hook Rate (Video)
| Zone | Range | Meaning |
|------|-------|---------|
| Excellent | 30%+ | Strong scroll-stopping creative |
| Solid | 25-30% | Above average |
| Watch | 20-25% | Below average, consider testing new hooks |
| Concern | 15-20% | Weak hooks, needs rework |
| Critical | <15% | Kill or complete rework |

### Frequency (7-day)
| Zone | Range | Meaning |
|------|-------|---------|
| Healthy | <1.5 | Fresh audience, room to scale |
| Normal | 1.5-2.5 | Standard delivery |
| Watch | 2.5-3.5 | Beginning to saturate, monitor closely |
| Concern | 3.5-4.5 | Audience fatigue likely, need new creative/audiences |
| Critical | >4.5 | Burning money, take action |

### CTR (Link Click-Through Rate)
| Zone | Range | Meaning |
|------|-------|---------|
| Excellent | >2% | Strong ad relevance |
| Solid | 1.5-2% | Above average |
| Watch | 1-1.5% | Average |
| Concern | 0.5-1% | Below average |
| Critical | <0.5% | Poor relevance or targeting |

---

## E-Commerce Benchmarks

### Funnel Conversion Rates (Typical Ranges)
| Stage | Good | Average | Poor |
|-------|------|---------|------|
| Click → LPV | >80% | 60-80% | <60% |
| LPV → View Content | >50% | 30-50% | <30% |
| View Content → ATC | >8% | 4-8% | <4% |
| ATC → Checkout | >50% | 30-50% | <30% |
| Checkout → Purchase | >60% | 40-60% | <40% |

### CPM Ranges
| Market | Low | Average | High |
|--------|-----|---------|------|
| US | $8-12 | $12-20 | $20-35 |
| UK | £6-10 | £10-16 | £16-25 |
| DACH (DE/AT/CH) | €7-11 | €11-18 | €18-28 |
| Nordics | €8-12 | €12-20 | €20-30 |

Note: CPMs vary significantly by:
- Season (Q4 can be 2-3x Q1)
- Vertical (supplements/health trigger higher CPMs)
- Targeting (broad < interest < lookalike < retargeting)
- Placement (Feed > Stories > Reels > Audience Network)

### ROAS Targets (Varies Heavily by Business)
| Business Model | Breakeven ROAS | Good ROAS | Excellent ROAS |
|----------------|----------------|-----------|----------------|
| Low AOV (<$30) | 3-4x | 4-6x | >6x |
| Mid AOV ($30-100) | 2-3x | 3-5x | >5x |
| High AOV (>$100) | 1.5-2.5x | 2.5-4x | >4x |
| Subscription (LTV play) | 1-1.5x | 1.5-2.5x | >2.5x |

---

## Lead Gen Benchmarks

### Funnel Conversion Rates
| Stage | Good | Average | Poor |
|-------|------|---------|------|
| Click → Landing Page | >80% | 60-80% | <60% |
| LP → Lead/Registration | >15% | 8-15% | <8% |
| Lead → Qualified (Net) | >70% | 50-70% | <50% |
| Qualified → Appointment (CR2) | >30% | 15-30% | <15% |
| Appointment → Sale (CR3) | >20% | 10-20% | <10% |

### CPL Ranges (Highly Variable)
| Vertical | Low | Average | High |
|----------|-----|---------|------|
| Webinar registration | $3-8 | $8-15 | $15-30 |
| B2B SaaS demo | $30-60 | $60-120 | $120-250 |
| Healthcare/Medical | $20-50 | $50-100 | $100-200 |
| Education/Course | $5-15 | $15-30 | $30-60 |
| Financial services | $20-50 | $50-100 | $100-200 |

---

## App Install Benchmarks

### Key Metrics
| Metric | Good | Average | Poor |
|--------|------|---------|------|
| CPI (Cost Per Install) | <$2 | $2-5 | >$5 |
| CPA (Cost Per Subscription) | <$30 | $30-60 | >$60 |
| Install → Trial | >30% | 15-30% | <15% |
| Trial → Subscription | >20% | 10-20% | <10% |

---

## Ads on Tap Client Benchmarks (from Transcripts)

These are real-world benchmarks from Daniel's agency portfolio. More accurate than generic benchmarks for similar verticals.

### E-Commerce Clients
| Client | Primary KPI | Target | Actual (Recent) |
|--------|-------------|--------|-----------------|
| Teeth Lovers | New customer CPA | Varies | ~€15 CPA on drops |
| Strays | NCCPA (via Klar) | €33/purchase | On target |
| Press London | ROAS + CPA | Varies by product | Cleanses > Shots > Meals |
| Laori | ROAS | Varies | Needs 3K€/day spend for profitability |
| Slumber | New customer CPA | Varies | V2 pixel + bid caps working well |

### Lead Gen Clients
| Client | Primary KPI | Target | Notes |
|--------|-------------|--------|-------|
| Audibena | Net CPL / CPA | €139 CPA (stated), real target €150-190 | 65+, 1-day click attribution |
| JV Academy | CPL (webinar reg) | ~£8-10/lead (UK) | US 2x better CVR than UK |
| Brain.fm | CPA (subscription) | $50 | Currently ~$34-39, client "ecstatic" |

### Key Vertical Patterns
- **Supplements/Health**: Higher CPMs due to Meta content penalties. Words matter.
- **Non-Alcoholic Drinks**: Weather-correlated demand. Sunny/warm = scale up.
- **Hearing Aids (65+)**: Android outperforms iOS. 55+ cheaper but lower CR3.
- **Juice Cleanses**: Seasonal (January = health month). Deal-sensitive, not price-sensitive.
- **SaaS/Apps**: Non-impulsive buy — conversions may happen in evenings, not daytime.

---

## Data Validation Ranges

Use these to catch calculation bugs or tracking errors before analysis:

| Metric | Valid Range | If Outside |
|--------|------------|------------|
| CTR | 0-20% | >20% = likely data error (decimal vs percentage) |
| Hook Rate | 0-100% | >50% = check Audience Network |
| Hold Rate | 0-100% | Normal: 15-40% |
| Frequency | 1-50 | >50 = data error |
| Funnel rates | 0-100% | >100% = event deduplication issue |
| CPM | $1-$100 | >$100 = check vertical/targeting (supplements can hit €130-193) |
| ROAS | 0-50x | >20x = check attribution window |
