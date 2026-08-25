import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The capability frame: one structured fact per scoped turn saying whether Ada
 * may execute in this account and, when she may not, the ONE thing stopping her.
 *
 * WHY it exists. On 2026-08-25 a founder flipped his account to human-in-the-loop
 * and asked Ada "does that work for you now?". She answered honestly and had to
 * guess: "if that toggle changed something on your end, I'm not seeing a new verb
 * on my side." She could read the rails, but the only shape she had for the
 * answer was prose, so the portal could do nothing with it. The frame is that
 * fact in a shape the portal can act on — `mode_read_only` is the one cause the
 * customer owns, so the chat draws the read-only switch beside the answer.
 *
 * Two properties have to hold, and neither is obvious from the happy path:
 *
 *  1. The reason is the RIGHT one. Precedence is not the order the rails are
 *     read in: a pressed STOP outranks the mode row it contradicts, and the mode
 *     outranks the fence, so a read-only account is never shown a setup problem
 *     it cannot fix. `no_lane` and `mode_read_only` point at different PEOPLE.
 *  2. A verb listed here is a promise. `verbs` is empty whenever `can_execute`
 *     is false, and a read that failed is `unknown` rather than a diagnosis we
 *     did not earn — offering a switch against a guessed cause is worse than
 *     offering none.
 *
 * The sentence Ada speaks and the frame the portal reads come from the same pure
 * mapping, which is what these tests drive; only the two Supabase reads are
 * mocked.
 */

const { state } = vi.hoisted(() => ({
  state: {
    /** Every `.eq()` the resolver made, so tenancy is visible, not assumed. */
    filters: [] as Array<{ table: string; column: string; value: string }>,
    clients: {} as Record<string, { ad_account_id: string | null; allowed_campaign_ids: string[] | null }>,
    guardSettings: {} as Record<string, { mode?: string | null; stopped_at?: string | null }>,
    throwOnRead: false,
  },
}));

vi.mock('../src/integrations/supabase.js', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const q = {
        _value: '',
        select: () => q,
        limit: () => q,
        eq: (column: string, value: string) => {
          state.filters.push({ table, column, value });
          q._value = value;
          return q;
        },
        maybeSingle: async () => {
          if (state.throwOnRead) throw new Error('supabase unreachable');
          if (table === 'clients') return { data: state.clients[q._value] ?? null, error: null };
          if (table === 'guard_settings') return { data: state.guardSettings[q._value] ?? null, error: null };
          return { data: null, error: null };
        },
        single: async () => ({ data: null, error: { message: 'not found' } }),
        insert: () => ({ then: (r: (v: unknown) => unknown) => r({ error: null }) }),
      };
      return q;
    },
  }),
}));

const {
  mapWriteCapability,
  toCapabilityFrame,
  resolveWriteCapability,
  parseControlInput,
  EXECUTABLE_VERBS,
} = await import('../scripts/ada-console-assist.js');

/** The three tinkers `ActionCommand` verbs — the whole ceiling, not a sample. */
const THREE_VERBS = ['pause', 'resume', 'set_daily_budget'];

const CANNOT = 'Today I cannot change anything in this account.';

describe('mapWriteCapability — which ONE thing is stopping her', () => {
  it('names the three verbs when the mode is open and the fence has a campaign', () => {
    const cap = mapWriteCapability({
      adAccountId: 'act_1', guardRow: { mode: 'hitl', stopped_at: null }, fence: ['120000'],
    });
    expect(cap).toMatchObject({ canExecute: true, reason: 'ok', verbs: THREE_VERBS });
    expect(cap.sentence).toContain('in the one campaign this account has opened to me');
    expect(cap.sentence).toContain('pausing something');
    // The ceiling is the ceiling: no create, duplicate or delete, ever.
    expect(cap.sentence).toContain('I cannot create campaigns or ad sets');
  });

  it('counts the fence in the sentence, and autonomous is an open mode too', () => {
    const cap = mapWriteCapability({
      adAccountId: 'act_1', guardRow: { mode: 'autonomous' }, fence: ['1', '2', '3'],
    });
    expect(cap.reason).toBe('ok');
    expect(cap.sentence).toContain('in the 3 campaigns this account has opened to me');
  });

  it('calls read-only by its name — the one cause the customer can fix', () => {
    expect(mapWriteCapability({
      adAccountId: 'act_1', guardRow: { mode: 'read_only' }, fence: ['120000'],
    }).reason).toBe('mode_read_only');
  });

  it('reads a missing guard row as read-only, fail-closed', () => {
    expect(mapWriteCapability({ adAccountId: 'act_1', guardRow: null, fence: ['120000'] }).reason)
      .toBe('mode_read_only');
    // A mode nobody recognises is not a mode that writes.
    expect(mapWriteCapability({ adAccountId: 'act_1', guardRow: { mode: 'paused_by_ops' }, fence: ['1'] }).reason)
      .toBe('mode_read_only');
  });

  it('lets a pressed STOP outrank everything, because it is the newest thing a human said', () => {
    // Open mode, open fence, STOP pressed: the mode row still says hitl and is wrong.
    expect(mapWriteCapability({
      adAccountId: 'act_1', guardRow: { mode: 'hitl', stopped_at: '2026-08-24T22:10:00Z' }, fence: ['120000'],
    }).reason).toBe('mode_stopped');
    // ...and outranks read_only as well, so the customer is told about the STOP
    // they pressed rather than about a switch that would not lift it.
    expect(mapWriteCapability({
      adAccountId: 'act_1', guardRow: { mode: 'read_only', stopped_at: '2026-08-24T22:10:00Z' }, fence: [],
    }).reason).toBe('mode_stopped');
  });

  it('calls an open mode with no fence a lane, not a mode', () => {
    for (const fence of [[], null, undefined]) {
      expect(mapWriteCapability({ adAccountId: 'act_1', guardRow: { mode: 'hitl' }, fence }).reason)
        .toBe('no_lane');
    }
  });

  it('never shows a read-only account a setup problem: mode beats lane', () => {
    // Both rails are shut. The customer owns exactly one of them, and that is
    // the one to name — `no_lane` here would point at us and leave their own
    // switch unmentioned.
    expect(mapWriteCapability({ adAccountId: 'act_1', guardRow: { mode: 'read_only' }, fence: [] }).reason)
      .toBe('mode_read_only');
  });

  it('says unknown rather than a diagnosis it did not earn', () => {
    expect(mapWriteCapability({ readFailed: true }).reason).toBe('unknown');
    // A read that failed outranks whatever rails happen to be in hand.
    expect(mapWriteCapability({
      readFailed: true, adAccountId: 'act_1', guardRow: { mode: 'hitl' }, fence: ['1'],
    }).reason).toBe('unknown');
    // An account we cannot find is not a read-only account: offering the switch
    // there would offer a fix for a cause we invented.
    expect(mapWriteCapability({ adAccountId: null, guardRow: { mode: 'hitl' }, fence: ['1'] }).reason)
      .toBe('unknown');
  });

  it('lists a verb only when it can dispatch one', () => {
    const shut = [
      mapWriteCapability({ readFailed: true }),
      mapWriteCapability({ adAccountId: null }),
      mapWriteCapability({ adAccountId: 'act_1', guardRow: { mode: 'read_only' } }),
      mapWriteCapability({ adAccountId: 'act_1', guardRow: { mode: 'hitl', stopped_at: 'now' }, fence: ['1'] }),
      mapWriteCapability({ adAccountId: 'act_1', guardRow: { mode: 'hitl' }, fence: [] }),
    ];
    expect(shut.map((c) => c.reason)).toEqual(['unknown', 'unknown', 'mode_read_only', 'mode_stopped', 'no_lane']);
    for (const cap of shut) {
      expect(cap.canExecute).toBe(false);
      expect(cap.verbs).toEqual([]);
      // One shut sentence for every shut reason: the prompt line carries the
      // difference, so no refusal can accidentally imply a verb.
      expect(cap.sentence).toContain(CANNOT);
    }
  });

  it('hands out a copy of the verb list, so a caller cannot widen the ceiling', () => {
    const cap = mapWriteCapability({ adAccountId: 'act_1', guardRow: { mode: 'hitl' }, fence: ['1'] });
    cap.verbs.push('delete_campaign');
    expect([...EXECUTABLE_VERBS]).toEqual(THREE_VERBS);
  });
});

describe('toCapabilityFrame — the wire shape the portal reads', () => {
  it('is the type, the boolean, the reason and the verbs, in the portal\'s casing', () => {
    const open = toCapabilityFrame(mapWriteCapability({
      adAccountId: 'act_1', guardRow: { mode: 'hitl' }, fence: ['120000'],
    }));
    expect(open).toEqual({ type: 'capability', can_execute: true, reason: 'ok', verbs: THREE_VERBS });
    expect(Object.keys(open).sort()).toEqual(['can_execute', 'reason', 'type', 'verbs']);
    // The prose Ada speaks stays out of the frame — the portal renders a switch,
    // not a second copy of the answer.
    expect(JSON.stringify(open)).not.toContain('approve');

    const shut = toCapabilityFrame(mapWriteCapability({ adAccountId: 'act_1', guardRow: { mode: 'read_only' } }));
    expect(shut).toEqual({ type: 'capability', can_execute: false, reason: 'mode_read_only', verbs: [] });
  });
});

describe('resolveWriteCapability — the two reads behind the frame', () => {
  beforeEach(() => {
    state.filters = [];
    state.clients = {};
    state.guardSettings = {};
    state.throwOnRead = false;
  });

  it('reads the scoped client and ITS account, and maps an open lane to ok', async () => {
    state.clients.BFM = { ad_account_id: 'act_1726935217614830', allowed_campaign_ids: ['120000', '120001'] };
    state.guardSettings.act_1726935217614830 = { mode: 'hitl', stopped_at: null };

    const cap = await resolveWriteCapability('BFM');
    expect(cap).toMatchObject({ canExecute: true, reason: 'ok', verbs: THREE_VERBS });
    // The guard row is looked up by the account the CLIENT row named, never by
    // anything the caller passed in beside the code.
    expect(state.filters).toEqual([
      { table: 'clients', column: 'code', value: 'BFM' },
      { table: 'guard_settings', column: 'ad_account_id', value: 'act_1726935217614830' },
    ]);
  });

  it('maps the account\'s own read_only row to the switchable reason', async () => {
    state.clients.BFM = { ad_account_id: 'act_1', allowed_campaign_ids: ['120000'] };
    state.guardSettings.act_1 = { mode: 'read_only', stopped_at: null };
    expect((await resolveWriteCapability('BFM')).reason).toBe('mode_read_only');
  });

  it('maps an account with no guard row at all to read_only, not to unknown', async () => {
    state.clients.BFM = { ad_account_id: 'act_1', allowed_campaign_ids: ['120000'] };
    expect((await resolveWriteCapability('BFM')).reason).toBe('mode_read_only');
  });

  it('maps an open mode with an empty fence to no_lane', async () => {
    state.clients.NHY = { ad_account_id: 'act_2', allowed_campaign_ids: [] };
    state.guardSettings.act_2 = { mode: 'hitl' };
    expect((await resolveWriteCapability('NHY')).reason).toBe('no_lane');
  });

  it('says unknown for a client it cannot find, and never reads a guard row for one', async () => {
    const cap = await resolveWriteCapability('NOPE');
    expect(cap).toMatchObject({ reason: 'unknown', canExecute: false, verbs: [] });
    expect(state.filters.some((f) => f.table === 'guard_settings')).toBe(false);
  });

  it('says unknown when the read itself fails, and logs why', async () => {
    state.throwOnRead = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cap = await resolveWriteCapability('BFM');
    expect(cap).toMatchObject({ reason: 'unknown', canExecute: false, verbs: [] });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * The portal's control block (2026-08-25, second pass). The two systems keep
 * separate switches and the first probe found them disagreeing: BFM's tinkers
 * controlMode said hitl while this side, reading its own guard_settings, said
 * read-only, because nothing in tinkers writes that table. The settled division
 * is that the PORTAL owns the mode and the STOP — it is the switch the customer
 * actually touches — and the droplet keeps the fence. So the request may carry
 * the mode, and where it does it wins; where it does not, nothing changes.
 */
describe('parseControlInput — validated, never trusted', () => {
  it('accepts the three modes with a boolean stop', () => {
    expect(parseControlInput({ mode: 'hitl', stopped: false })).toEqual({ mode: 'hitl', stopped: false });
    expect(parseControlInput({ mode: 'autonomous', stopped: true })).toEqual({ mode: 'autonomous', stopped: true });
    expect(parseControlInput({ mode: 'read_only', stopped: false })).toEqual({ mode: 'read_only', stopped: false });
    // Extra keys are ignored rather than carried: the shape we read is the
    // shape we documented.
    expect(parseControlInput({ mode: 'hitl', stopped: false, account_id: 'act_1' }))
      .toEqual({ mode: 'hitl', stopped: false });
  });

  it('is all-or-nothing: a half-formed block is a caller we do not understand', () => {
    for (const bad of [
      undefined, null, 'hitl', 42, [], [{ mode: 'hitl', stopped: false }],
      {}, { mode: 'hitl' }, { stopped: true },
      { mode: 'off', stopped: false }, { mode: 'HITL', stopped: false },
      { mode: 'hitl', stopped: 'yes' }, { mode: 'hitl', stopped: 1 }, { mode: null, stopped: false },
    ]) {
      expect(parseControlInput(bad)).toBeNull();
    }
  });
});

describe('mapWriteCapability — the portal owns the mode, we own the fence', () => {
  /** A guard row that would say read-only on its own, so the override is visible. */
  const staleGuardRow = { mode: 'read_only', stopped_at: null };

  it('opens the lane on the portal\'s word, over a guard row that never heard', () => {
    const cap = mapWriteCapability({
      adAccountId: 'act_1', guardRow: staleGuardRow, fence: ['120000'],
      control: { mode: 'hitl', stopped: false },
    });
    expect(cap).toMatchObject({ canExecute: true, reason: 'ok', openMode: 'hitl', verbs: THREE_VERBS });
  });

  it('still calls an empty fence a lane, however open the portal says the mode is', () => {
    // The half we own. A verb promised here would have nowhere to land.
    const cap = mapWriteCapability({
      adAccountId: 'act_1', guardRow: staleGuardRow, fence: [],
      control: { mode: 'hitl', stopped: false },
    });
    expect(cap).toMatchObject({ canExecute: false, reason: 'no_lane', verbs: [], openMode: 'hitl' });
    expect(mapWriteCapability({
      adAccountId: 'act_1', fence: null, control: { mode: 'autonomous', stopped: false },
    }).openMode).toBe('autonomous');
  });

  it('lets the portal\'s STOP outrank everything, including its own mode', () => {
    expect(mapWriteCapability({
      adAccountId: 'act_1', guardRow: { mode: 'hitl', stopped_at: null }, fence: ['120000'],
      control: { mode: 'hitl', stopped: true },
    })).toMatchObject({ reason: 'mode_stopped', canExecute: false, verbs: [] });
  });

  it('lets the portal shut a lane the guard row would have opened', () => {
    // The override runs both ways, or it is not a source of truth.
    expect(mapWriteCapability({
      adAccountId: 'act_1', guardRow: { mode: 'hitl', stopped_at: null }, fence: ['120000'],
      control: { mode: 'read_only', stopped: false },
    }).reason).toBe('mode_read_only');
    // ...and a guard row's stale STOP no longer stops a portal that says otherwise.
    expect(mapWriteCapability({
      adAccountId: 'act_1', guardRow: { mode: 'hitl', stopped_at: '2026-08-24T22:10:00Z' }, fence: ['120000'],
      control: { mode: 'hitl', stopped: false },
    }).reason).toBe('ok');
  });

  it('changes nothing when no control block came, or when it was thrown out', () => {
    const rails = { adAccountId: 'act_1', guardRow: staleGuardRow, fence: ['120000'] } as const;
    expect(mapWriteCapability(rails).reason).toBe('mode_read_only');
    expect(mapWriteCapability({ ...rails, control: null }).reason).toBe('mode_read_only');
    expect(mapWriteCapability({ ...rails, control: parseControlInput({ mode: 'hitl' }) }).reason)
      .toBe('mode_read_only');
    // The open case is unchanged too: no control block, guard row decides.
    expect(mapWriteCapability({ ...rails, guardRow: { mode: 'hitl' } }).reason).toBe('ok');
  });

  it('still says unknown when the reads it owns did not come back', () => {
    // The portal's mode cannot rescue a missing fence: without the client row
    // there is nothing to tell `ok` and `no_lane` apart.
    const control = { mode: 'hitl', stopped: false } as const;
    expect(mapWriteCapability({ readFailed: true, control }).reason).toBe('unknown');
    expect(mapWriteCapability({ adAccountId: null, control }).reason).toBe('unknown');
  });

  it('keeps openMode out of the wire frame', () => {
    const frame = toCapabilityFrame(mapWriteCapability({
      adAccountId: 'act_1', fence: [], control: { mode: 'hitl', stopped: false },
    }));
    expect(Object.keys(frame).sort()).toEqual(['can_execute', 'reason', 'type', 'verbs']);
    expect(frame).toEqual({ type: 'capability', can_execute: false, reason: 'no_lane', verbs: [] });
  });
});

describe('resolveWriteCapability — the control block reaches the mapping', () => {
  beforeEach(() => {
    state.filters = [];
    state.clients = {};
    state.guardSettings = {};
    state.throwOnRead = false;
  });

  it('answers on the portal\'s mode and our fence, not on the stale guard row', async () => {
    state.clients.BFM = { ad_account_id: 'act_1726935217614830', allowed_campaign_ids: ['120000'] };
    state.guardSettings.act_1726935217614830 = { mode: 'read_only', stopped_at: null };

    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const cap = await resolveWriteCapability('BFM', { mode: 'hitl', stopped: false });
    expect(cap).toMatchObject({ canExecute: true, reason: 'ok', verbs: THREE_VERBS });
    debug.mockRestore();
  });

  it('logs the disagreement as two reason words and a client code, and nothing else', async () => {
    state.clients.BFM = { ad_account_id: 'act_1', allowed_campaign_ids: null };
    // No guard row at all — BFM's real shape on the night this was written.
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    const cap = await resolveWriteCapability('BFM', { mode: 'hitl', stopped: false });
    expect(cap.reason).toBe('no_lane');

    expect(debug).toHaveBeenCalledTimes(1);
    const line = String(debug.mock.calls[0]?.[0]);
    // Strict: the whole line is the sentence, the code and the two verdicts. No
    // account id, and nothing the caller put in the body echoed back.
    expect(line).toMatch(
      /^\[ada-console-assist\] control sources disagree for BFM: portal (ok|mode_read_only|mode_stopped|no_lane|unknown), guard row (ok|mode_read_only|mode_stopped|no_lane|unknown)$/,
    );
    expect(line).toContain('portal no_lane');
    expect(line).toContain('guard row mode_read_only');
    expect(line).not.toContain('act_');
    debug.mockRestore();
  });

  it('says nothing when the two switches agree, and nothing when none was sent', async () => {
    state.clients.BFM = { ad_account_id: 'act_1', allowed_campaign_ids: ['120000'] };
    state.guardSettings.act_1 = { mode: 'hitl', stopped_at: null };
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    expect((await resolveWriteCapability('BFM', { mode: 'hitl', stopped: false })).reason).toBe('ok');
    expect(debug).not.toHaveBeenCalled();
    // No block at all is the old path, and the old path never compared anything.
    expect((await resolveWriteCapability('BFM')).reason).toBe('ok');
    expect(debug).not.toHaveBeenCalled();
    debug.mockRestore();
  });
});
