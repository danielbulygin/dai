import { beforeEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ turn: 0, requestMessages: [] as unknown[], stored: [] as Array<Record<string, unknown>> }));
vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    static APIError = class extends Error {};
    static APIConnectionError = class extends Error {};
    messages = { stream: (request: { messages: unknown[] }) => {
      const turn = fake.turn++;
      fake.requestMessages.push(structuredClone(request.messages));
      let text: ((text: string) => void) | undefined;
      return {
        on: (_event: string, callback: (text: string) => void) => { text = callback; },
        finalMessage: async () => {
          text?.('All four tasks marked Done.');
          return {
            content: turn === 0 ? [{ type: 'tool_use', id: 'operation-1', name: 'update_aot_task_status', input: { task_id: 'task-A', new_status: 'Done' } }] : [{ type: 'text', text: 'All four tasks marked Done.' }],
            stop_reason: turn === 0 ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      };
    } };
  }
  return { default: FakeAnthropic };
});
vi.mock('../src/env.js', () => ({ env: { ANTHROPIC_API_KEY: 'fake' } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/agents/registry.js', () => ({ getAgent: (id: string) => ({
  config: { id, display_name: id, profile: 'test', model: 'fake', max_turns: 3, constitution: false },
  persona: 'fixture', instructions: 'fixture', manifest: { path: '/not-used' }, extras: [],
}), getDefaultAgent: vi.fn() }));
vi.mock('../src/agents/constitution.js', () => ({ getConstitution: () => '' }));
vi.mock('../src/memory/sessions.js', () => ({
  findSession: async (_c: string, _t: string, id: string) => ({ id: 'session', agent_id: id, total_turns: 0 }),
  createSession: vi.fn(), updateSession: vi.fn(),
}));
vi.mock('../src/memory/messages.js', () => ({
  getMessages: async () => [{ role: 'assistant', content: 'Exact prior task context' }],
  addMessage: async (input: Record<string, unknown>) => { fake.stored.push(input); },
}));
vi.mock('../src/memory/search.js', () => ({ getQuickContext: async () => ({ topLearnings: [], userLearnings: [] }), getClientQuickContext: vi.fn() }));
vi.mock('../src/agents/tool-registry.js', () => ({
  getToolsForProfile: () => ({ definitions: [{ name: 'update_aot_task_status', input_schema: { type: 'object', properties: {} } }] }),
  executeTool: async () => ({ result: '{"ok":false,"error":"readback mismatch"}', isError: false }),
}));
vi.mock('../src/agents/hooks/session-lifecycle.js', () => ({ buildJasminPreferenceContext: vi.fn() }));
vi.mock('../src/memory/learnings.js', () => ({ incrementApplied: vi.fn() }));
vi.mock('../src/client-agents/prompt-builder.js', () => ({ buildClientOverlay: vi.fn() }));
vi.mock('../src/agents/agent-directory.js', () => ({ buildAgentDirectorySection: () => '' }));
vi.mock('../src/agents/launch-state.js', () => ({ extractBatchIds: () => [], getBatchStates: vi.fn(), buildLaunchStateSection: vi.fn() }));
vi.mock('../src/agents/client-context.js', () => ({ detectClientCodes: () => [], loadClientContextExtras: vi.fn(), loadMethodologyExtra: vi.fn(), loadClientTargetsExtra: vi.fn(), loadClientLearningsExtra: vi.fn() }));
vi.mock('../src/agents/workflow-context.js', () => ({ detectLaunchShaped: () => false, loadLaunchWorkflowExtra: vi.fn() }));
vi.mock('../src/integrations/supabase.js', () => ({ getSupabase: () => { throw new Error('Network prohibited'); } }));

import { runAgent } from '../src/agents/runner.js';
beforeEach(() => { fake.turn = 0; fake.requestMessages.length = fake.stored.length = 0; vi.stubGlobal('fetch', () => { throw new Error('Network prohibited'); }); });
describe('real runner with scripted model and denied transports', () => {
  it('Piper receives a tool error, suppresses every streamed claim and persists only verified projection', async () => {
    const onText = vi.fn();
    const result = await runAgent({ agentId: 'piper', userId: 'U_TEST', channelId: 'C_TEST', userMessage: 'Finish task-A', onText });
    expect(onText).not.toHaveBeenCalled();
    expect(result.response).toContain('0 verified, 1 unresolved');
    expect(result.response).not.toContain('All four tasks marked Done');
    expect(JSON.stringify(fake.requestMessages[1])).toContain('"is_error":true');
    expect(fake.stored[1]?.content).toBe(result.response);
  });
  it('Ada preserves the existing streamed and soft-error behavior', async () => {
    const onText = vi.fn();
    const result = await runAgent({ agentId: 'ada', userId: 'U_TEST', channelId: 'C_TEST', userMessage: 'Finish task-A', onText });
    expect(onText).toHaveBeenCalled();
    expect(result.response).toContain('All four tasks marked Done');
    expect(JSON.stringify(fake.requestMessages[1])).toContain('"is_error":false');
  });
});
