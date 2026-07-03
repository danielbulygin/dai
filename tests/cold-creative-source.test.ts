import { describe, it, expect } from 'vitest';
import {
  rankTopAds, extractLibraryMedia, matchLibraryMedia, pickMedia,
  buildColdCreativeFacts, fallbackWinners,
  type GraphCreativeLite, type LibraryMediaCandidate, type CreativeRead, type TopAdsSummary,
} from '../src/audit/cold-creative-source.js';
import type { PackAdRow } from '../src/audit/report-pack.js';
import type { LibraryAd } from '../src/audit/library-triage.js';

/**
 * Pure logic behind the cold-path creative analysis: top-ad ranking, the
 * media-resolution fallback ladder (Graph video → library video → images →
 * thumbnail), Ads-Library text matching, and the deterministic winners
 * fallback. No network anywhere — these pin the section's decision logic.
 */

function row(over: Partial<PackAdRow> & { ad_id: string }): PackAdRow {
  return {
    ad_name: `ad-${over.ad_id}`,
    date: '2026-07-01',
    spend: 100,
    impressions: 10_000,
    purchases: 5,
    purchase_value: 400,
    results: 0,
    frequency: null,
    hook_rate: null,
    hold_rate: null,
    ...over,
  };
}

describe('rankTopAds', () => {
  it('aggregates per ad, sorts by spend, and caps the list', () => {
    const rows: PackAdRow[] = [
      row({ ad_id: 'a', spend: 50 }),
      row({ ad_id: 'a', spend: 70, purchase_value: 100 }),
      row({ ad_id: 'b', spend: 300 }),
      row({ ad_id: 'c', spend: 10 }),
    ];
    const s = rankTopAds(rows, 2);
    expect(s.ads.map((a) => a.ad_id)).toEqual(['b', 'a']);
    expect(s.ads_with_spend).toBe(3);
    expect(s.ads[1]!.spend).toBe(120);
    expect(s.ads[1]!.roas).toBeCloseTo(500 / 120, 2);
    expect(s.total_spend).toBe(430);
  });

  it('drops zero-spend ads', () => {
    const s = rankTopAds([row({ ad_id: 'a', spend: 0 })]);
    expect(s.ads).toHaveLength(0);
    expect(s.ads_with_spend).toBe(0);
    expect(s.top12_spend_share_pct).toBe(0);
  });

  it('flags video via hook/hold rate and computes video spend share', () => {
    const rows: PackAdRow[] = [
      row({ ad_id: 'v', spend: 75, hook_rate: 0.25 }),
      row({ ad_id: 's', spend: 25 }),
    ];
    const s = rankTopAds(rows);
    expect(s.ads.find((a) => a.ad_id === 'v')!.is_video).toBe(true);
    expect(s.ads.find((a) => a.ad_id === 's')!.is_video).toBe(false);
    expect(s.video_spend_share_pct).toBe(75);
  });

  it('computes top-12 share over ALL spending ads even when cap < 12', () => {
    const rows: PackAdRow[] = Array.from({ length: 14 }, (_, i) =>
      row({ ad_id: `a${i}`, spend: i < 12 ? 100 : 50 }),
    );
    const s = rankTopAds(rows, 5);
    expect(s.ads).toHaveLength(5);
    // 12×100 of 1300 total
    expect(s.top12_spend_share_pct).toBe(Math.round((1200 / 1300) * 100));
  });

  it('weights hook_rate by impressions', () => {
    const rows: PackAdRow[] = [
      row({ ad_id: 'v', spend: 10, hook_rate: 0.4, impressions: 1000 }),
      row({ ad_id: 'v', spend: 10, hook_rate: 0.1, impressions: 3000 }),
    ];
    const s = rankTopAds(rows);
    // (0.4*1000 + 0.1*3000) / 4000 = 0.175
    expect(s.ads[0]!.hook_rate).toBeCloseTo(0.175, 4);
  });
});

describe('extractLibraryMedia', () => {
  it('reads video urls from snapshot.videos, cards, and images from either', () => {
    const ads: LibraryAd[] = [
      {
        snapshot: {
          body: { text: 'Video ad body text here' },
          videos: [{ video_sd_url: 'https://cdn/video-sd.mp4', video_hd_url: 'https://cdn/video-hd.mp4' }] as unknown[],
        },
      },
      {
        snapshot: {
          cards: [{ body: 'Card body', title: 'Card Title', video_hd_url: 'https://cdn/card-hd.mp4' }],
        },
      },
      {
        snapshot: {
          body: { text: 'Static ad body' },
          images: [{ original_image_url: 'https://cdn/img.jpg' }] as unknown[],
        },
      },
      { snapshot: { body: { text: 'no media at all' } } },
    ];
    const out = extractLibraryMedia(ads);
    expect(out).toHaveLength(3);
    expect(out[0]!.video_url).toBe('https://cdn/video-sd.mp4'); // SD preferred (smaller download)
    expect(out[0]!.body).toBe('video ad body text here');
    expect(out[1]!.video_url).toBe('https://cdn/card-hd.mp4');
    expect(out[1]!.title).toBe('card title');
    expect(out[2]!.video_url).toBeNull();
    expect(out[2]!.image_url).toBe('https://cdn/img.jpg');
  });
});

describe('matchLibraryMedia', () => {
  const candidates: LibraryMediaCandidate[] = [
    { body: 'stop scrolling if your knees hurt every morning — this changed everything for me', title: null, video_url: 'https://cdn/a.mp4', image_url: null },
    { body: 'stop scrolling if your knees hurt every morning — this changed everything for me', title: null, video_url: null, image_url: 'https://cdn/a.jpg' },
    { body: 'summer sale now live', title: 'the comfy short', video_url: null, image_url: 'https://cdn/b.jpg' },
  ];

  it('matches on normalized body prefix and prefers the candidate with video', () => {
    const m = matchLibraryMedia(
      { body: 'Stop scrolling   if your KNEES hurt every morning — this changed everything for me and thousands of others', title: null },
      candidates,
    );
    expect(m?.video_url).toBe('https://cdn/a.mp4');
  });

  it('refuses to match on short/generic bodies', () => {
    expect(matchLibraryMedia({ body: 'summer sale', title: null }, candidates)).toBeNull();
  });

  it('falls back to exact title match', () => {
    const m = matchLibraryMedia({ body: null, title: 'The Comfy Short' }, candidates);
    expect(m?.image_url).toBe('https://cdn/b.jpg');
  });

  it('returns null when nothing matches', () => {
    expect(matchLibraryMedia({ body: 'a completely different creative body that matches nothing', title: 'nope nope' }, candidates)).toBeNull();
  });
});

describe('pickMedia — the resolution ladder', () => {
  const graph: GraphCreativeLite = {
    ad_id: '1', body: null, title: null, video_id: 'v1',
    image_url: 'https://graph/img.jpg', thumbnail_url: 'https://graph/thumb.jpg',
  };
  const lib: LibraryMediaCandidate = { body: 'x', title: null, video_url: 'https://lib/v.mp4', image_url: 'https://lib/i.jpg' };

  it('graph video source wins outright', () => {
    const m = pickMedia({ videoSourceUrl: 'https://graph/source.mp4', graph, lib });
    expect(m).toEqual({ kind: 'video', url: 'https://graph/source.mp4', source: 'graph_video_source' });
  });

  it('library video beats any image', () => {
    const m = pickMedia({ videoSourceUrl: null, graph, lib });
    expect(m).toEqual({ kind: 'video', url: 'https://lib/v.mp4', source: 'library_video' });
  });

  it('graph full image beats library image beats thumbnail', () => {
    const noVideoLib = { ...lib, video_url: null };
    expect(pickMedia({ videoSourceUrl: null, graph, lib: noVideoLib })!.source).toBe('graph_image');
    expect(pickMedia({ videoSourceUrl: null, graph: { ...graph, image_url: null }, lib: noVideoLib })!.source).toBe('library_image');
    expect(pickMedia({ videoSourceUrl: null, graph: { ...graph, image_url: null }, lib: null })!.source).toBe('graph_thumbnail');
  });

  it('returns null when nothing is resolvable', () => {
    expect(pickMedia({ videoSourceUrl: null, graph: null, lib: null })).toBeNull();
  });
});

describe('winners synthesis inputs + fallback', () => {
  const summary: TopAdsSummary = {
    ads: [
      { ad_id: '1', ad_name: 'UGC-hook-A', spend: 900, roas: 3.4, purchases: 40, leads: 0, hook_rate: 0.31, is_video: true },
      { ad_id: '2', ad_name: 'Static-B', spend: 500, roas: 0, purchases: 0, leads: 25, hook_rate: null, is_video: false },
      { ad_id: '3', ad_name: 'Video-C', spend: 200, roas: 0, purchases: 0, leads: 0, hook_rate: 0.18, is_video: true },
    ],
    ads_with_spend: 3,
    total_spend: 1600,
    top12_spend_share_pct: 100,
    video_spend_share_pct: 69,
  };
  const reads: CreativeRead[] = [
    {
      ad_id: '1', ad_name: 'UGC-hook-A', hook: 'woman says "I threw out all my bras"',
      angle: 'comfort over shapewear', format: 'UGC selfie talking head', casting: 'woman ~35, bedroom',
      media_source: 'library_video', kind: 'video',
    },
  ];

  it('fallbackWinners picks the sharpest stat per ad and grounds why in the read', () => {
    const w = fallbackWinners(summary, reads);
    expect(w).toHaveLength(3);
    expect(w[0]).toMatchObject({ ad_name: 'UGC-hook-A', spend: 900, key_stat: 'Meta ROAS 3.4' });
    expect(w[0]!.why).toContain('UGC selfie talking head');
    expect(w[0]!.why).toContain('threw out all my bras');
    expect(w[1]!.key_stat).toBe('25 leads');
    expect(w[2]!.key_stat).toBe('hook rate 18%');
    expect(w[2]!.why).toContain('not readable');
  });

  it('buildColdCreativeFacts attaches graph copy + creative reads per top ad', () => {
    const graphByAdId = new Map<string, GraphCreativeLite>([
      ['1', { ad_id: '1', body: 'Primary text of ad one', title: 'Headline one', video_id: 'v', image_url: null, thumbnail_url: null }],
    ]);
    const facts = buildColdCreativeFacts({
      accountName: 'Acme', currency: 'EUR', summary, graphByAdId, reads,
      unresolved: [{ ad_name: 'Video-C', spend: 200, reason: 'no retrievable media' }],
    }) as {
      top_ads: Array<Record<string, unknown>>;
      unresolved_media: Array<Record<string, unknown>>;
      ads_with_spend: number;
      video_spend_share_pct: number;
    };
    expect(facts.ads_with_spend).toBe(3);
    expect(facts.video_spend_share_pct).toBe(69);
    const first = facts.top_ads[0]!;
    expect(first.primary_text).toBe('Primary text of ad one');
    expect(first.hook_rate_pct).toBe(31);
    expect((first.creative_read as Record<string, unknown>).hook_first_3s).toContain('threw out');
    expect((first.creative_read as Record<string, unknown>).media_source).toBe('library_video');
    expect(facts.top_ads[1]!.creative_read).toBeUndefined();
    expect(facts.unresolved_media[0]!.ad_name).toBe('Video-C');
  });
});

// ---------------------------------------------------------------------------
// coerceStringList — LLM string-array contract repair (live incident 2026-07-04)
// ---------------------------------------------------------------------------
import { coerceStringList } from '../src/audit/cold-creative.js';

describe('coerceStringList', () => {
  it('passes plain string arrays through', () => {
    expect(coerceStringList(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('coerces numbered-keyed objects to their string values (the NBN incident shape)', () => {
    expect(coerceStringList([{ '1': 'first gap' }, { '2': 'second gap' }])).toEqual(['first gap', 'second gap']);
  });

  it('joins multi-value objects, drops empty/valueless items, stringifies primitives', () => {
    expect(coerceStringList([{ a: 'x', b: 'y' }, {}, '', '  ', 42, null, ['nested']])).toEqual(['x y', '42']);
  });

  it('returns [] for non-arrays', () => {
    expect(coerceStringList({ '1': 'not a list' })).toEqual([]);
    expect(coerceStringList(undefined)).toEqual([]);
  });
});
