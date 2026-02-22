import { describe, it, expect, beforeAll } from 'vitest';
import { routeMessage } from '../src/orchestrator/router.js';

// The router calls loadAgentRegistry() internally, which reads YAML files.
// We need the agent files to exist for this to work.

describe('routeMessage', () => {
  const BOT_USER_ID = 'U_BOT_123';

  it('strips bot mention and defaults to otto', () => {
    const result = routeMessage(`<@${BOT_USER_ID}> hello there`, BOT_USER_ID);
    expect(result.agentId).toBe('otto');
    expect(result.cleanedText).toBe('hello there');
  });

  it('routes to coda when mentioned by name', () => {
    const result = routeMessage(`<@${BOT_USER_ID}> ask Coda to review this`, BOT_USER_ID);
    // Should match either via prefix pattern "ask coda" or keyword "coda"
    expect(result.agentId).toBe('coda');
  });

  it('routes to rex with "hey rex" prefix', () => {
    const result = routeMessage(`<@${BOT_USER_ID}> hey rex what is TypeScript`, BOT_USER_ID);
    expect(result.agentId).toBe('rex');
  });

  it('routes to sage when name appears in text', () => {
    const result = routeMessage(`<@${BOT_USER_ID}> can sage review my code`, BOT_USER_ID);
    expect(result.agentId).toBe('sage');
  });

  it('defaults to otto for generic messages', () => {
    const result = routeMessage(`<@${BOT_USER_ID}> what is the weather today`, BOT_USER_ID);
    expect(result.agentId).toBe('otto');
    expect(result.cleanedText).toBe('what is the weather today');
  });

  it('handles text with no mentions', () => {
    const result = routeMessage('just a plain message', BOT_USER_ID);
    expect(result.agentId).toBe('otto');
    expect(result.cleanedText).toBe('just a plain message');
  });

  it('routes with "tell sage" prefix', () => {
    const result = routeMessage(`<@${BOT_USER_ID}> tell sage to check quality`, BOT_USER_ID);
    expect(result.agentId).toBe('sage');
  });
});
