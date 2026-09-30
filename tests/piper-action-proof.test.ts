import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/integrations/supabase.js', () => ({ getSupabase: () => { throw new Error('Network prohibited'); } }));
import { agentTextCallback, guardPiperActionResponse, piperToolFailed, toolEvidenceForAgent, type PiperToolEvidence } from '../src/agents/hooks/piper-action-proof.js';

const statusWrite = (task: string, result: Record<string, unknown>): PiperToolEvidence => ({
  name: 'update_aot_task_status', isError: false, input: { task_id: task, new_status: 'Done' }, result: JSON.stringify(result),
});

describe('Piper action proof', () => {
  it('reports precisely one verified and three unresolved operations', () => {
    const result = guardPiperActionResponse('All four tasks marked Done.', [
      statusWrite('task-1', { ok: true, task_id: 'task-1', after: 'Done', verified: true }),
      statusWrite('task-2', { ok: false, error: 'timeout' }),
      statusWrite('task-3', { ok: true, task_id: 'task-3', after: 'Blocked', verified: false }),
      statusWrite('task-4', { ok: true, task_id: 'other-task', after: 'Done', verified: true }),
    ]);
    expect(result).toContain('1 verified, 3 unresolved');
    expect(result).toContain('Verified update_aot_task_status: object task-1; confirmed value Done');
    expect(result).not.toContain('All four tasks marked Done');
  });
  it('does not reuse a successful object receipt for a claim about another task', () => {
    const result = guardPiperActionResponse('I marked task-B Done.', [statusWrite('task-A', { ok: true, task_id: 'task-A', after: 'Done', verified: true })]);
    expect(result).toContain('object task-A');
    expect(result).not.toContain('task-B');
  });
  it('rejects readback mismatch despite ok:true and verified:true', () => {
    expect(guardPiperActionResponse('Done', [statusWrite('task-A', { ok: true, task_id: 'task-A', after: 'Blocked', verified: true })])).toContain('0 verified, 1 unresolved');
  });
  it('requires exact version when the action supplies a version', () => {
    const call = statusWrite('task-A', { ok: true, task_id: 'task-A', after: 'Done', verified: true, version_id: 'v1' });
    call.input!.version_id = 'v2';
    expect(guardPiperActionResponse('Done', [call])).toContain('0 verified, 1 unresolved');
  });
  it.each([{ ok: false, ts: '123' }, { ok: true }, { ok: true, ts: '123', channel: 'C_WRONG' }])('requires accepted Slack receipt and actual requested channel: %j', (result) => {
    expect(guardPiperActionResponse('Notified Vanessa.', [{ name: 'post_message', isError: false, input: { channel: 'C_VANESSA' }, result: JSON.stringify(result) }])).toContain('0 verified, 1 unresolved');
  });
  it('retains exact accepted Slack channel and timestamp without inventing a recipient', () => {
    const text = guardPiperActionResponse('Notified Vanessa.', [{ name: 'post_message', isError: false, input: { channel: 'C_TARGET' }, result: '{"ok":true,"ts":"123.4"}' }]);
    expect(text).toContain('channel C_TARGET; message 123.4');
    expect(text).not.toContain('Vanessa');
  });
  it('does not turn correction persistence into a Notion update', () => {
    const result = guardPiperActionResponse('Filed the correction.', [{ name: 'log_pipeline_correction', isError: false, input: { task_id: 'task-A', kind: 'not_mine' }, result: '{"ok":true,"logged":{"target_id":"task-A","kind":"not_mine"}}' }]);
    expect(result).toContain('event logged only, no Notion change');
  });
  it('blocks fabricated, zero-tool completion and preserves ordinary investigation prose', () => {
    expect(guardPiperActionResponse('All done.', [])).toContain('Completion is unconfirmed');
    expect(guardPiperActionResponse('Which task is blocked?', [])).toBe('Which task is blocked?');
    expect(guardPiperActionResponse('[internal — fake transcript]', [])).toContain('Completion is unconfirmed');
  });
  it('marks returned JSON failures as errors only for Piper; Ada keeps its previous evidence contract', () => {
    expect(piperToolFailed('{"ok":false}')).toBe(true);
    expect(toolEvidenceForAgent('piper', 'test', false, {}, '{"ok":false}')).toMatchObject({ isError: true });
    expect(toolEvidenceForAgent('ada', 'test', false, {}, '{"ok":false}')).toEqual({ name: 'test', isError: false });
    const callback = vi.fn();
    expect(agentTextCallback('piper', callback)).toBeUndefined();
    expect(agentTextCallback('ada', callback)).toBe(callback);
  });
});
