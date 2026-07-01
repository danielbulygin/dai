import { describe, it, expect } from 'vitest';
import {
  detectClientCodes,
  formatClientTargetsSection,
  formatClientLearningsSection,
  loadClientTargetsExtra,
  loadClientLearningsExtra,
  buildClientKnowledgeBundle,
} from '../src/agents/client-context.js';
import { buildSynthSystem, summarizeDataWindow } from '../src/audit/magic-audit.js';

/**
 * Phase B — the client context layer. The JVA golden-case eval fail proved the
 * web loop answered client questions without client-scoped knowledge; these
 * tests pin the injection helpers, the audit synthesis composition, and the
 * knowledge CONTENT itself (JVA's mini-course mapping must never de-drift).
 */

describe('client knowledge formatters (pure)', () => {
  it('targets section renders the config and instructs target-anchoring', () => {
    const s = formatClientTargetsSection('TL', { kpi_primary: 'roas', targets: { roas: 3 } })!;
    expect(s).toContain('Client Targets & KPI Config — TL');
    expect(s).toContain('"kpi_primary"');
    expect(s).toContain('ANCHOR every judgment');
  });

  it('targets section is null on a config error payload', () => {
    expect(formatClientTargetsSection('XX', { error: 'No config found' })).toBeNull();
  });

  it('learnings section dedups, caps at 10, newest-first semantics stated', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ content: `learning ${i}` }));
    const s = formatClientLearningsSection('JVA', [...many, { content: 'learning 0' }])!;
    expect(s).toContain('Client Learnings — JVA');
    expect((s.match(/^- /gm) ?? []).length).toBe(10);
    expect(s).toContain('newest first');
  });

  it('learnings section is null when empty', () => {
    expect(formatClientLearningsSection('JVA', [])).toBeNull();
  });
});

describe('client knowledge loaders are fail-soft (no env / no DB)', () => {
  it('loadClientTargetsExtra returns null instead of throwing', async () => {
    expect(await loadClientTargetsExtra('TL')).toBeNull();
  });
  it('loadClientLearningsExtra returns null instead of throwing', async () => {
    expect(await loadClientLearningsExtra('TL')).toBeNull();
  });
});

describe('the JVA knowledge content (regression pin for the golden case)', () => {
  it('detectClientCodes finds JVA in the golden-case question', () => {
    expect(detectClientCodes(["I'm launching the JVA mini-course ads. What conversion event should the ad set optimize for?"])).toContain('JVA');
  });

  it('JVA client intelligence carries the mini-course mapping (file + bundle)', async () => {
    // The bundle degrades to the intelligence FILE without a DB — which must
    // itself carry the mapping, so even a context-starved run knows it.
    const bundle = await buildClientKnowledgeBundle('JVA');
    expect(bundle).toContain('Client Intelligence — JVA');
    expect(bundle).toContain('INITIATED_CHECKOUT');
    expect(bundle).toContain('minicourse');
    expect(bundle).toContain('2446814');
    expect(bundle).toContain('NOT LEAD and NOT COMPLETE_REGISTRATION');
  });
});

describe('audit synthesis composition', () => {
  it('buildSynthSystem embeds the client context + anchoring instruction', () => {
    const s = buildSynthSystem('## Client Targets — TL\ntarget roas 3', null);
    expect(s).toContain('CLIENT CONTEXT (anchor every judgment to it)');
    expect(s).toContain('target roas 3');
    expect(s).toContain('app trials, leads, appointments, offsite checkout');
  });

  it('buildSynthSystem without knowledge or caveat is the base prompt only', () => {
    const s = buildSynthSystem('', null);
    expect(s).not.toContain('CLIENT CONTEXT');
    expect(s).not.toContain('DATA WINDOW CAUTION');
  });

  it('a thin data window produces the caveat; a full one does not', () => {
    const thin = summarizeDataWindow(Array.from({ length: 100 }, (_, i) => `2026-06-${String((i % 10) + 1).padStart(2, '0')}`));
    expect(thin.daysWithData).toBe(10);
    expect(thin.caveat).toContain('only 10 of the last 30 days');

    const full = summarizeDataWindow(Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`));
    expect(full.daysWithData).toBe(30);
    expect(full.caveat).toBeNull();

    expect(buildSynthSystem('', thin.caveat)).toContain('DATA WINDOW CAUTION');
  });
});
