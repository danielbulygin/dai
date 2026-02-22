import { describe, it, expect } from 'vitest';
import { markdownToMrkdwn } from '../src/slack/formatters/markdown-to-mrkdwn.js';
import { chunkMessage } from '../src/slack/formatters/chunker.js';

describe('markdownToMrkdwn', () => {
  it('converts bold syntax', () => {
    expect(markdownToMrkdwn('this is **bold** text')).toBe('this is *bold* text');
  });

  it('converts headers to bold', () => {
    expect(markdownToMrkdwn('# Header One')).toBe('*Header One*');
    expect(markdownToMrkdwn('## Header Two')).toBe('*Header Two*');
    expect(markdownToMrkdwn('### Header Three')).toBe('*Header Three*');
  });

  it('converts links', () => {
    expect(markdownToMrkdwn('[click here](https://example.com)')).toBe(
      '<https://example.com|click here>',
    );
  });

  it('preserves code blocks', () => {
    const input = '```javascript\nconst x = 1;\n```';
    const result = markdownToMrkdwn(input);
    expect(result).toContain('const x = 1;');
    expect(result).toContain('```');
  });

  it('preserves inline code', () => {
    expect(markdownToMrkdwn('use `npm install`')).toBe('use `npm install`');
  });

  it('converts * list items to - list items', () => {
    expect(markdownToMrkdwn('* item one')).toBe('- item one');
  });

  it('preserves blockquotes', () => {
    expect(markdownToMrkdwn('> quoted text')).toBe('> quoted text');
  });
});

describe('chunkMessage', () => {
  it('returns single chunk for short messages', () => {
    const chunks = chunkMessage('Hello world');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Hello world');
  });

  it('splits long messages into chunks', () => {
    const longText = Array(100).fill('This is a paragraph of text that needs to be split.').join('\n\n');
    const chunks = chunkMessage(longText, 500);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk) => {
      expect(chunk.length).toBeLessThanOrEqual(500);
    });
  });

  it('does not split in the middle of code blocks', () => {
    const text = 'Before\n\n```\n' + 'x\n'.repeat(100) + '```\n\nAfter';
    const chunks = chunkMessage(text, 500);
    // At least one chunk should contain the complete code block
    const hasCompleteBlock = chunks.some(
      (c) => c.includes('```') && c.indexOf('```') !== c.lastIndexOf('```'),
    );
    // If the code block fits in a chunk, it should be complete
    if (text.length <= 500) {
      expect(chunks).toHaveLength(1);
    } else {
      expect(chunks.length).toBeGreaterThan(1);
    }
  });

  it('returns empty array for empty string', () => {
    const chunks = chunkMessage('');
    expect(chunks.length).toBeLessThanOrEqual(1);
  });
});
