import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parsePortalContext,
  renderPortalContextBlock,
  buildScopedChatPrompt,
  buildChatPrompt,
} from '../scripts/ada-console-assist.js';

/**
 * What the portal knows, on the wire and in the prompt (tinkers ADR 0079).
 *
 * WHY it exists. Ada was a thin proxy. A customer could type their goal, their
 * bands, their business facts and the rules they wanted run into the portal, and
 * none of it reached the turn — so the next question got an answer that ignored
 * what they had just typed. `portal_context` carries it, and these tests pin the
 * two things that make it honest rather than merely present.
 *
 *  1. ABSENT and EMPTY are different sentences. A section the portal could not
 *     read arrives absent and is named in `unavailable`; a section it read and
 *     found empty arrives as `[]`. Collapsing the two turns "I could not look"
 *     into "there is none", which is a fabricated receipt, and it is the whole
 *     reason the field has a shape at all.
 *  2. A block we cannot use costs the customer nothing. Every live scoped turn
 *     already runs this code path, so a malformed block, an unknown version, or
 *     an element we cannot render must degrade to NO block and leave the prompt
 *     byte-identical to the one that shipped before it — never fail the turn.
 *
 * The fixture in tests/fixtures/ is the pre-patch prompt, captured from this
 * same function before the field existed. Regenerate it deliberately, never to
 * make a red test green.
 */

const BASELINE = readFileSync('tests/fixtures/scoped-prompt-no-portal-context.txt', 'utf-8');
const QUESTION = 'How did last week go?';
const CODE = 'ZZTESTCO';

const AS_OF = '2026-08-25T01:40:12.000Z';

const account = {
  id: 'acct_1',
  external_id: 'act_1570076840279279',
  name: 'Brain.fm',
  currency: 'USD',
  timezone: 'America/Los_Angeles',
  control_mode: 'read_only',
  stopped: false,
  target: { metric: 'cpa', value: 40, set_at: '2026-08-20' },
  bands: { status: 'confirmed', ecstatic: 32, happy: 40, nervous: 48, kill: 80 },
};
const fact = { id: 'f1', topic: 'business model', fact: 'Annual subscription, 7-day trial.', source: 'customer' };
const rule = { id: 'r1', rule: 'Pause an ad past 3.4 frequency', action: 'notify', checkable: true };
const finding = {
  id: 'fi1',
  severity: 'red',
  headline: 'Frequency past the line',
  entity: { level: 'AD', id: '123', name: 'Sleep hook v3' },
  receipt: 'frequency 4.1 over 7 days, against your 3.4',
  opened_at: '2026-08-24T06:00:00.000Z',
  status: 'OPEN',
};

const block = (over: Record<string, unknown> = {}) => ({
  v: 1,
  as_of: AS_OF,
  account,
  facts: [fact],
  rules: [rule],
  findings: [finding],
  unavailable: [],
  truncated: [],
  ...over,
});

const scoped = (req: Record<string, unknown>) => buildScopedChatPrompt(req as never, CODE);

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------

describe('parsePortalContext', () => {
  it('returns null for absent, empty, array, no version and a future version', () => {
    expect(parsePortalContext(undefined)).toBeNull();
    expect(parsePortalContext(null)).toBeNull();
    expect(parsePortalContext({})).toBeNull();
    expect(parsePortalContext([])).toBeNull();
    expect(parsePortalContext('v1')).toBeNull();
    expect(parsePortalContext({ as_of: AS_OF })).toBeNull();
    // A shape we do not understand is not a shape we half-read.
    expect(parsePortalContext({ v: 2, as_of: AS_OF })).toBeNull();
    expect(parsePortalContext({ v: '1', as_of: AS_OF })).toBeNull();
  });

  it('returns null without a usable as_of, since the block is quoted with its stamp', () => {
    expect(parsePortalContext({ v: 1 })).toBeNull();
    expect(parsePortalContext({ v: 1, as_of: '' })).toBeNull();
    expect(parsePortalContext({ v: 1, as_of: 17 })).toBeNull();
  });

  it('parses a valid block whole', () => {
    const ctx = parsePortalContext(block());
    expect(ctx).not.toBeNull();
    expect(ctx?.as_of).toBe(AS_OF);
    expect(ctx?.account?.external_id).toBe('act_1570076840279279');
    expect(ctx?.facts).toHaveLength(1);
    expect(ctx?.rules).toHaveLength(1);
    expect(ctx?.findings).toHaveLength(1);
  });

  it('keeps an EMPTY section empty and an ABSENT section absent', () => {
    // The two states the whole feature turns on.
    const empty = parsePortalContext({ v: 1, as_of: AS_OF, facts: [], unavailable: [], truncated: [] });
    expect(empty?.facts).toEqual([]);
    expect('facts' in (empty as object)).toBe(true);

    const missing = parsePortalContext({ v: 1, as_of: AS_OF, unavailable: ['facts'], truncated: [] });
    expect('facts' in (missing as object)).toBe(false);
    expect(missing?.facts).toBeUndefined();
    expect(missing?.unavailable).toEqual(['facts']);
  });

  it('defaults the two name lists and drops non-string names', () => {
    const ctx = parsePortalContext({ v: 1, as_of: AS_OF, unavailable: ['findings', 7, null], truncated: 'nope' });
    expect(ctx?.unavailable).toEqual(['findings']);
    expect(ctx?.truncated).toEqual([]);
  });

  it('ignores an account that is not an object', () => {
    expect(parsePortalContext({ v: 1, as_of: AS_OF, account: [] })?.account).toBeUndefined();
    expect(parsePortalContext({ v: 1, as_of: AS_OF, account: 'acct_1' })?.account).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('renderPortalContextBlock', () => {
  const render = (over: Record<string, unknown> = {}) => renderPortalContextBlock(parsePortalContext(block(over)));

  it('renders nothing at all for a block that did not parse', () => {
    expect(renderPortalContextBlock(null)).toBe('');
    expect(renderPortalContextBlock(parsePortalContext({ v: 2, as_of: AS_OF }))).toBe('');
  });

  it('heads the section with the stamp and the three reading rules', () => {
    const out = render();
    expect(out).toContain(`### What the portal knows (as of ${AS_OF})`);
    expect(out).toContain('**This block wins.**');
    expect(out).toContain('**Say where it came from when they ask.**');
    expect(out).toContain('**Never read this back as a list.**');
  });

  it('renders the account with its mode, goal and bands', () => {
    const out = render();
    expect(out).toContain('- Account: Brain.fm [acct_1] · act_1570076840279279 · USD · America/Los_Angeles');
    expect(out).toContain('- What they have allowed: mode read_only');
    expect(out).not.toContain('STOPPED');
    expect(out).toContain('- Their goal: cpa 40, set 2026-08-20 (set on the Business page)');
    expect(out).toContain('- Their bands (confirmed): ecstatic 32 · happy 40 · nervous 48 · kill 80');
  });

  it('says the account is stopped when it is, and says a missing goal is missing', () => {
    const out = render({ account: { ...account, stopped: true, target: null, bands: null } });
    expect(out).toContain('the account is STOPPED');
    expect(out).toContain('- Their goal: not set yet.');
    expect(out).not.toContain('Their bands');
  });

  it('renders facts, rules and findings with their ids', () => {
    const out = render();
    expect(out).toContain('- What they have told you about the business (1):');
    expect(out).toContain('  - business model: Annual subscription, 7-day trial. [f1, from customer]');
    expect(out).toContain('- Rules they run (1):');
    expect(out).toContain('  - Pause an ad past 3.4 frequency → notify [r1, checked automatically]');
    expect(out).toContain('- Open catches on this account (1):');
    expect(out).toContain('RED: Frequency past the line on Sleep hook v3 (ad)');
    expect(out).toContain('frequency 4.1 over 7 days, against your 3.4');
    expect(out).toContain('[fi1, open since 2026-08-24]');
  });

  it('marks a rule nothing checks, so Ada never implies one runs', () => {
    const out = render({ rules: [{ ...rule, checkable: false }] });
    expect(out).toContain('words only, nothing checks it');
  });

  it('renders an EMPTY section as the fact that there is nothing, per section', () => {
    const out = render({ facts: [], rules: [], findings: [] });
    expect(out).toContain('- What they have told you about the business: nothing yet.');
    expect(out).toContain('- Rules they run: none adopted yet.');
    expect(out).toContain('- Open catches on this account: none open right now.');
  });

  it('renders NOTHING for an ABSENT section — not "none"', () => {
    const out = renderPortalContextBlock(
      parsePortalContext({ v: 1, as_of: AS_OF, account, unavailable: ['facts', 'rules', 'findings'], truncated: [] }),
    );
    expect(out).not.toContain('What they have told you about the business');
    expect(out).not.toContain('Rules they run');
    expect(out).not.toContain('Open catches on this account');
  });

  it('says a section could not be READ, and never lists it as empty', () => {
    const out = renderPortalContextBlock(
      parsePortalContext({ v: 1, as_of: AS_OF, account, facts: [fact], unavailable: ['findings'], truncated: [] }),
    );
    expect(out).toContain('- COULD NOT READ this turn: findings.');
    expect(out).toContain('This is NOT "there is none"');
    expect(out).toContain('never answer as if the section were empty');
    expect(out).not.toContain('Open catches on this account');
  });

  it('says a section was SHORTENED, so "these are all of them" is never implied', () => {
    const out = render({ truncated: ['facts', 'findings'] });
    expect(out).toContain('- SHORTENED to fit: facts, findings.');
    expect(out).toContain('There are more than the ones listed');
  });

  it('trims a long sentence rather than letting one fact eat the block', () => {
    const long = 'x'.repeat(900);
    const out = render({ facts: [{ ...fact, fact: long }] });
    expect(out).toContain('…');
    expect(out).not.toContain('x'.repeat(500));
  });

  it('renders nothing when the block carries no section at all', () => {
    expect(renderPortalContextBlock(parsePortalContext({ v: 1, as_of: AS_OF, unavailable: [], truncated: [] }))).toBe('');
  });
});

// ---------------------------------------------------------------------------

describe('buildScopedChatPrompt with the portal block', () => {
  it('is byte-identical to the pre-patch prompt when no portal_context is sent', () => {
    expect(scoped({ question: QUESTION })).toBe(BASELINE);
  });

  it('is byte-identical when the request carries only the console’s own context', () => {
    // The two keys are unrelated: `context` is the INTERNAL console's screen
    // context and this patch must not have taught the scoped door to read it.
    const out = scoped({
      question: QUESTION,
      context: { gate: 'launch', client_code: 'SOMEONE_ELSE', asset_code: 'A1', title: 'a screen', payload: { v: 1 } },
    });
    expect(out).toBe(BASELINE);
  });

  it('degrades to no block, and never throws, on a block it cannot parse', () => {
    for (const bad of [{}, [], 'x', { v: 2, as_of: AS_OF }, { v: 1 }, { v: 1, as_of: AS_OF, facts: 'nope' }]) {
      const out = scoped({ question: QUESTION, portal_context: bad });
      if (typeof bad === 'object' && bad !== null && (bad as { v?: number }).v === 1 && 'as_of' in bad) continue;
      expect(out).toBe(BASELINE);
    }
  });

  it('degrades to no block when an element cannot be rendered, rather than failing the turn', () => {
    // The portal owns the element shape; a finding with no severity is a wire
    // bug, and a wire bug must cost the customer an omitted block, not a turn.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = scoped({
      question: QUESTION,
      portal_context: block({ findings: [{ id: 'fi1', headline: 'no severity here' }] }),
    });
    expect(out).toBe(BASELINE);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('portal_context render failed'),
      expect.any(String),
    );
  });

  it('places the block after the client overlay and before How to answer', () => {
    const out = scoped({ question: QUESTION, portal_context: block() });
    const blockAt = out.indexOf('### What the portal knows');
    const howAt = out.indexOf('### How to answer');
    expect(blockAt).toBeGreaterThan(0);
    expect(blockAt).toBeLessThan(howAt);
  });

  it('carries the prefer-the-portal rule and the cite-the-source rule', () => {
    const out = scoped({ question: QUESTION, portal_context: block() });
    expect(out).toContain('Where it and anything in your client file disagree, this is right');
    expect(out).toContain('set on the Business page');
  });

  it('adds the staleness sentence only when there is a block to be stale', () => {
    const withBlock = scoped({ question: QUESTION, portal_context: block() });
    expect(withBlock).toContain('The portal block above carries the time it was read.');
    expect(withBlock).toContain('working from what the portal held a few minutes ago');
    expect(scoped({ question: QUESTION })).not.toContain('carries the time it was read');
  });

  it('keeps the block out of the INTERNAL console prompt entirely', () => {
    const internal = buildChatPrompt({ question: QUESTION, portal_context: block() } as never);
    expect(internal).not.toContain('### What the portal knows');
    expect(internal).not.toContain('Where it and anything in your client file disagree');
    expect(internal).not.toContain('act_1570076840279279');
  });
});
