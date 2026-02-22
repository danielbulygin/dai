import { describe, it, expect } from 'vitest';
import { loadSkill, loadSkillsForAgent } from '../src/skills/loader.js';
import { validateSkill } from '../src/skills/validator.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

describe('Skills Loader', () => {
  it('loads a skill from .skill.md file', () => {
    const skillPath = path.join(projectRoot, 'agents/_skills/code-review.skill.md');
    const skill = loadSkill(skillPath);

    expect(skill.name).toBe('code-review');
    expect(skill.description).toBeTruthy();
    expect(skill.tags).toContain('coding');
    expect(skill.content.length).toBeGreaterThan(0);
  });

  it('loads shared skills for any agent', () => {
    const skills = loadSkillsForAgent('otto');
    // Should load at least the 3 shared skills
    expect(skills.length).toBeGreaterThanOrEqual(3);

    const names = skills.map((s) => s.name);
    expect(names).toContain('code-review');
    expect(names).toContain('summarize');
    expect(names).toContain('research');
  });
});

describe('Skills Validator', () => {
  it('validates a correct skill', () => {
    const result = validateSkill({
      name: 'test-skill',
      description: 'A test skill',
      tags: ['test'],
      content: 'Do the thing',
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects skill with missing name', () => {
    const result = validateSkill({
      name: '',
      description: 'A test skill',
      tags: ['test'],
      content: 'Do the thing',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects skill with missing content', () => {
    const result = validateSkill({
      name: 'test',
      description: 'A test skill',
      tags: [],
      content: '',
    });
    expect(result.valid).toBe(false);
  });
});
