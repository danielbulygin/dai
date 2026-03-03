import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { getToolsForProfile } from '../src/agents/tool-registry.js';

const AGENTS_DIR = join(process.cwd(), 'agents', 'ada');

function readMarkdown(filePath: string): string {
  const raw = readFileSync(filePath, 'utf-8');
  const { content } = matter(raw);
  return content.trim();
}

const persona = readMarkdown(join(AGENTS_DIR, 'PERSONA.md'));
const instructions = readMarkdown(join(AGENTS_DIR, 'INSTRUCTIONS.md'));

const SKIP = new Set(['PERSONA.md', 'INSTRUCTIONS.md']);
const extras: string[] = [];
for (const file of readdirSync(AGENTS_DIR)) {
  if (!file.endsWith('.md') || file.endsWith('.skill.md') || SKIP.has(file)) continue;
  const content = readMarkdown(join(AGENTS_DIR, file));
  if (content) extras.push(content);
}

const now = new Date().toLocaleString('en-GB', {
  timeZone: 'Europe/Berlin', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

const systemPrompt = [
  `## Current Date & Time\n${now} (Europe/Berlin)`,
  persona,
  instructions,
  ...extras,
  '## Key Learnings\n- Some example learning about ads',
].join('\n\n');

console.log('System prompt chars:', systemPrompt.length);

async function main() {
  const client = new Anthropic();

  const userMessage = 'Hi Ada, can you please do a deep dive into the JVA ad account? I need to know specifically for the UK in the last 60 days what happened because the cost per lead has been increasing.';

  // Count without tools
  const r1 = await client.messages.countTokens({
    model: 'claude-opus-4-6',
    system: [{ type: 'text', text: systemPrompt }],
    messages: [{ role: 'user', content: userMessage }],
  });
  console.log('Token count WITHOUT tools:', r1.input_tokens);

  // Load actual tool registry
  const { definitions: toolDefs } = getToolsForProfile('media_buyer');
  console.log('Tool count:', toolDefs.length);
  
  // Show each tool name and JSON size
  for (const tool of toolDefs) {
    const json = JSON.stringify(tool);
    console.log(`  ${tool.name}: ${json.length} chars`);
  }
  
  const totalToolChars = toolDefs.reduce((s, t) => s + JSON.stringify(t).length, 0);
  console.log('Total tool JSON chars:', totalToolChars);

  // Count with actual tools
  const cachedTools: Anthropic.Tool[] = toolDefs.map((tool, i) =>
    i === toolDefs.length - 1
      ? { ...tool, cache_control: { type: 'ephemeral' as const } }
      : tool,
  );

  const r2 = await client.messages.countTokens({
    model: 'claude-opus-4-6',
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' as const } }],
    messages: [{ role: 'user', content: userMessage }],
    tools: cachedTools,
  });
  console.log('Token count WITH tools:', r2.input_tokens);
  console.log('Tool overhead:', r2.input_tokens - r1.input_tokens, 'tokens');
}

main().catch(console.error);
