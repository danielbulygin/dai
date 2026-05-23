/**
 * Terminal chat with Piper (or any DAI agent).
 *
 * Usage:
 *   pnpm chat:piper                 # interactive REPL
 *   pnpm chat:piper "what's slipping"   # single-shot question
 *
 * Override agent with PIPER_AGENT_ID env var, e.g. PIPER_AGENT_ID=ada pnpm chat:piper
 *
 * Stubs Slack env vars so you can run without registering the Piper Slack app
 * first. All Anthropic + Supabase + Notion env vars still need to be real.
 */

import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

for (const key of [
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_OWNER_USER_ID',
]) {
  if (!process.env[key]) process.env[key] = `stub-${key}`;
}

process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

const { runAgent } = await import('../src/agents/runner.js');

const AGENT_ID = process.env.PIPER_AGENT_ID ?? 'piper';
const SESSION_ID = `terminal-${randomUUID()}`;
const TERMINAL_USER = process.env.USER ?? 'terminal-user';
const TERMINAL_CHANNEL = `terminal-${TERMINAL_USER}`;

function color(s: string, code: string): string {
  return `\x1b[${code}m${s}\x1b[0m`;
}

async function ask(question: string): Promise<void> {
  const toolCalls: string[] = [];
  const result = await runAgent({
    agentId: AGENT_ID,
    userMessage: question,
    userId: TERMINAL_USER,
    channelId: TERMINAL_CHANNEL,
    threadTs: SESSION_ID,
    sessionId: SESSION_ID,
    onToolUse: (toolName) => {
      toolCalls.push(toolName);
      process.stderr.write(color(`[tool: ${toolName}]\n`, '90'));
    },
  });

  process.stdout.write(result.response);
  process.stdout.write('\n');

  const u = result.usage;
  const usageLine = `tokens: in=${u.input} out=${u.output}${u.cacheRead ? ` cacheRead=${u.cacheRead}` : ''}${u.cacheCreation ? ` cacheCreation=${u.cacheCreation}` : ''} · turns=${result.turns}${toolCalls.length ? ` · tools=${toolCalls.join(',')}` : ''}`;
  console.error(color(usageLine, '90'));
}

async function main(): Promise<void> {
  const argInput = process.argv.slice(2).join(' ').trim();

  console.error(color(`Talking to ${AGENT_ID} · session ${SESSION_ID}`, '36'));
  console.error(color('Ctrl-D / Ctrl-C to exit.', '90'));
  console.error('');

  if (argInput) {
    await ask(argInput);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.setPrompt(color('you > ', '32'));
  rl.prompt();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }
    process.stdout.write(color(`${AGENT_ID} > `, '35'));
    try {
      await ask(trimmed);
    } catch (err) {
      console.error(color(`error: ${(err as Error).message}`, '31'));
    }
    rl.prompt();
  });

  rl.on('close', () => {
    console.error(color('\nbye', '90'));
    process.exit(0);
  });
}

await main();
