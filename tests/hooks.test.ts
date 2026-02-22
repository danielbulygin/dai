import { describe, it, expect } from 'vitest';
import { shouldCapture } from '../src/agents/hooks/memory-capture.js';
import { checkToolSafety } from '../src/agents/hooks/security.js';

describe('Memory Capture - shouldCapture', () => {
  it('skips noisy read tools', () => {
    expect(shouldCapture('Read')).toBe(false);
    expect(shouldCapture('Glob')).toBe(false);
    expect(shouldCapture('Grep')).toBe(false);
  });

  it('captures write tools', () => {
    expect(shouldCapture('Write')).toBe(true);
    expect(shouldCapture('Edit')).toBe(true);
  });

  it('captures Bash', () => {
    expect(shouldCapture('Bash')).toBe(true);
  });

  it('captures web tools', () => {
    expect(shouldCapture('WebSearch')).toBe(true);
    expect(shouldCapture('WebFetch')).toBe(true);
  });
});

describe('Security - checkToolSafety', () => {
  it('allows normal bash commands', () => {
    const result = checkToolSafety('Bash', { command: 'ls -la' });
    expect(result.allowed).toBe(true);
  });

  it('blocks rm -rf', () => {
    const result = checkToolSafety('Bash', { command: 'rm -rf /' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('blocks DROP TABLE', () => {
    const result = checkToolSafety('Bash', { command: "sqlite3 db.sqlite 'DROP TABLE users'" });
    expect(result.allowed).toBe(false);
  });

  it('blocks access to sensitive paths', () => {
    const result = checkToolSafety('Bash', { command: 'cat /etc/shadow' });
    expect(result.allowed).toBe(false);
  });

  it('blocks git push --force to main', () => {
    const result = checkToolSafety('Bash', { command: 'git push --force origin main' });
    expect(result.allowed).toBe(false);
  });

  it('allows git push without force', () => {
    const result = checkToolSafety('Bash', { command: 'git push origin feature-branch' });
    expect(result.allowed).toBe(true);
  });

  it('allows non-Bash tools without checking', () => {
    const result = checkToolSafety('Write', { file: '/tmp/test.txt' });
    expect(result.allowed).toBe(true);
  });

  it('blocks DELETE FROM without WHERE', () => {
    const result = checkToolSafety('Bash', { command: "sqlite3 db.sqlite 'DELETE FROM users'" });
    expect(result.allowed).toBe(false);
  });
});
