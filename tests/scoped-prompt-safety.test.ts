import { describe, it, expect } from 'vitest';
import {
  SAFETY_RULES_SECTION,
  buildScopedChatPrompt,
  buildChatPrompt,
} from '../scripts/ada-console-assist.js';

/**
 * The founder's standing safety rules, stated on the CUSTOMER door.
 *
 * WHY it exists. Every rule in this section is one Ada cannot recover from by
 * being clever afterwards. Attribution is fixed the moment an ad set is created;
 * editing an object that has already spent throws away the learning that spend
 * bought; a delete is gone. Before this section she knew none of them, so the
 * only thing standing between a customer and a proposal that quietly picks CBO,
 * or a build sheet with no attribution named, was whether the model happened to
 * remember. A rule the prompt does not carry is not a rule.
 *
 * Two properties are worth pinning rather than trusting:
 *
 *  1. The section reaches the door it was written for. It goes into the SCOPED
 *     prompt and stays out of the internal one, which frames a teammate with a
 *     real write surface, not a customer reading a proposal.
 *  2. It is read BEFORE the shape of a proposal. The rules constrain what may be
 *     proposed, so a prompt that puts the proposal rail first has them arriving
 *     as an afterthought to a card already drafted.
 *
 * The rules are asserted one at a time, on the load-bearing phrase rather than
 * the whole sentence: a reword is fine, dropping the rule is not.
 */

const req = { question: 'Should I raise the budget on my best campaign?' };

describe('SAFETY_RULES_SECTION', () => {
  it('carries all six rules, each on its own line', () => {
    const rules = SAFETY_RULES_SECTION.split('\n').filter((l) => l.startsWith('- '));
    expect(rules).toHaveLength(6);
  });

  it('states that attribution is immutable after creation, with a default', () => {
    expect(SAFETY_RULES_SECTION).toContain('Attribution is chosen once');
    expect(SAFETY_RULES_SECTION).toContain('cannot be changed afterwards');
    // The rule is useless without the fallback: "state it explicitly" with no
    // default just moves the guess one step later.
    expect(SAFETY_RULES_SECTION).toContain("spend-weighted");
  });

  it('forbids editing a spent object, and says copying is the way round it', () => {
    expect(SAFETY_RULES_SECTION).toContain('Never edit an ad set or an ad that has already spent');
    expect(SAFETY_RULES_SECTION).toContain('Copy it');
    // Pausing and adding ads stay allowed — a rule that over-reaches gets ignored.
    expect(SAFETY_RULES_SECTION).toContain('adding new ads to an existing ad set');
  });

  it('forbids deleting anything and lands everything new PAUSED', () => {
    expect(SAFETY_RULES_SECTION).toContain('Never delete anything, ever');
    expect(SAFETY_RULES_SECTION).toContain('Everything new lands PAUSED');
    expect(SAFETY_RULES_SECTION).toContain('stays PAUSED');
  });

  it('hands campaign structure back to the customer rather than defaulting it', () => {
    expect(SAFETY_RULES_SECTION).toContain('CBO or ABO');
    expect(SAFETY_RULES_SECTION).toContain('bid strategy and optimization goal');
    expect(SAFETY_RULES_SECTION).toContain('Never pick one quietly');
  });

  it('names the on-platform destinations that are never dead pages', () => {
    for (const host of ['fb.me', 'm.me', 'wa.me', 'facebook.com', 'instagram.com']) {
      expect(SAFETY_RULES_SECTION).toContain(host);
    }
    expect(SAFETY_RULES_SECTION).toContain('never advise pausing an ad because it points at one');
  });

  it('requires the five readiness facts before any proposal', () => {
    for (const fact of ['pixel', 'conversion event', 'destination URL', 'Page and Instagram identity']) {
      expect(SAFETY_RULES_SECTION).toContain(fact);
    }
    // "I could not read the pixel" and "there is no pixel" are different facts,
    // and the rule is worthless if a missing one can pass silently.
    expect(SAFETY_RULES_SECTION).toContain('say which one before you propose anything');
  });

  it('uses no em-dash, because these lines are the ones a customer reads back', () => {
    // House rule for customer-facing copy. The rest of this prompt is guidance
    // Ada paraphrases; these are sentences she is told to state as written.
    expect(SAFETY_RULES_SECTION).not.toContain('—');
  });
});

describe('the safety rules on the customer door', () => {
  it('is in the scoped prompt', () => {
    expect(buildScopedChatPrompt(req, 'AOTUS')).toContain(SAFETY_RULES_SECTION);
  });

  it('is NOT in the internal console prompt', () => {
    const internal = buildChatPrompt(req);
    expect(internal).not.toContain(SAFETY_RULES_SECTION);
    expect(internal).not.toContain('### Rules I never break');
  });

  it('is read before the proposal rail, not after the card is drafted', () => {
    const prompt = buildScopedChatPrompt(req, 'AOTUS');
    const rules = prompt.indexOf('### Rules I never break');
    const rail = prompt.indexOf('### Proposing account changes');
    expect(rules).toBeGreaterThan(-1);
    expect(rail).toBeGreaterThan(-1);
    expect(rules).toBeLessThan(rail);
  });
});

/**
 * Web search on the customer door (B3). The guard has allowed WebSearch/WebFetch
 * all along; what was missing was any instruction about WHAT they are for, and
 * the failure that invites is the expensive one: reaching for the open web to
 * answer a question about the customer's own account, where the tools are the
 * only source that is actually theirs.
 */
describe('the web-search rule', () => {
  const prompt = buildScopedChatPrompt(req, 'AOTUS');

  it('names both tools and confines them to public facts', () => {
    expect(prompt).toContain('**WebSearch** and **WebFetch** are for PUBLIC facts only');
  });

  it('forbids pointing them at this customer account, and demands a source', () => {
    expect(prompt).toContain("never for anything about this customer's account");
    expect(prompt).toContain('name the source you read');
  });
});
