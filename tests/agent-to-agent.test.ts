import { describe, it, expect } from 'vitest';
import {
  createHandoffMessage,
  isAgentToAgentMessage,
  parseHandoff,
} from '../src/orchestrator/agent-to-agent.js';

describe('Agent-to-Agent Communication', () => {
  const handoff = {
    fromAgent: 'otto',
    toAgent: 'coda',
    task: 'Review the authentication module',
    context: 'User asked for a code review of auth',
    channelId: 'C123',
    threadTs: 'T456',
  };

  it('creates a handoff message', () => {
    const message = createHandoffMessage(handoff);
    expect(message).toBeTruthy();
    expect(message.length).toBeGreaterThan(0);
  });

  it('detects agent-to-agent messages', () => {
    const message = createHandoffMessage(handoff);
    expect(isAgentToAgentMessage(message, 'U_BOT')).toBe(true);
  });

  it('does not detect normal messages as agent-to-agent', () => {
    expect(isAgentToAgentMessage('Hello world', 'U_BOT')).toBe(false);
  });

  it('roundtrips a handoff message', () => {
    const message = createHandoffMessage(handoff);
    const parsed = parseHandoff(message);
    expect(parsed).not.toBeNull();
    expect(parsed!.fromAgent).toBe('otto');
    expect(parsed!.toAgent).toBe('coda');
    expect(parsed!.task).toBe('Review the authentication module');
  });
});
