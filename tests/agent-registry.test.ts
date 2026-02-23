import { describe, it, expect } from 'vitest';
import { loadAgentRegistry, getAgent, getDefaultAgent } from '../src/agents/registry.js';
import { toolProfiles } from '../src/agents/profiles/index.js';

describe('Agent Registry', () => {
  it('loads all 6 agents from manifest', () => {
    const registry = loadAgentRegistry();
    expect(registry.size).toBe(6);
    expect(registry.has('otto')).toBe(true);
    expect(registry.has('coda')).toBe(true);
    expect(registry.has('rex')).toBe(true);
    expect(registry.has('sage')).toBe(true);
    expect(registry.has('ada')).toBe(true);
    expect(registry.has('jasmin')).toBe(true);
  });

  it('getAgent returns correct agent', () => {
    const coda = getAgent('coda');
    expect(coda).toBeDefined();
    expect(coda!.config.id).toBe('coda');
    expect(coda!.config.display_name).toBe('Coda');
    expect(coda!.config.profile).toBe('coding');
    expect(coda!.config.max_turns).toBe(25);
  });

  it('getAgent returns undefined for unknown agent', () => {
    const unknown = getAgent('nonexistent');
    expect(unknown).toBeUndefined();
  });

  it('getDefaultAgent returns otto', () => {
    const defaultAgent = getDefaultAgent();
    expect(defaultAgent.config.id).toBe('otto');
    expect(defaultAgent.config.display_name).toBe('Otto');
  });

  it('each agent has persona and instructions', () => {
    const registry = loadAgentRegistry();
    for (const [id, agent] of registry) {
      expect(agent.persona.length).toBeGreaterThan(0);
      expect(agent.instructions.length).toBeGreaterThan(0);
    }
  });

  it('otto has sub_agents configured', () => {
    const otto = getAgent('otto');
    expect(otto!.config.sub_agents).toEqual(['coda', 'rex', 'sage', 'ada', 'jasmin']);
  });

  it('each agent has a valid tool profile', () => {
    const registry = loadAgentRegistry();
    const validProfiles = Object.keys(toolProfiles);
    for (const [, agent] of registry) {
      expect(validProfiles).toContain(agent.config.profile);
    }
  });
});

describe('Tool Profiles', () => {
  it('readonly profile has read-only tools', () => {
    expect(toolProfiles.readonly).toContain('Read');
    expect(toolProfiles.readonly).toContain('Glob');
    expect(toolProfiles.readonly).toContain('Grep');
    expect(toolProfiles.readonly).not.toContain('Write');
    expect(toolProfiles.readonly).not.toContain('Bash');
  });

  it('coding profile includes write tools', () => {
    expect(toolProfiles.coding).toContain('Write');
    expect(toolProfiles.coding).toContain('Edit');
    expect(toolProfiles.coding).toContain('Bash');
  });

  it('standard profile has bash but not write/edit', () => {
    expect(toolProfiles.standard).toContain('Bash');
    expect(toolProfiles.standard).not.toContain('Write');
    expect(toolProfiles.standard).not.toContain('Edit');
  });
});
