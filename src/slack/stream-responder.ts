import type { WebClient } from '@slack/web-api';
import { logger } from '../utils/logger.js';
import { markdownToMrkdwn, chunkMessage } from './formatters/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StreamResponderOptions {
  client: WebClient;
  channel: string;
  threadTs?: string;
  userMessageTs: string;
  agentName: string;
}

export interface StreamResponderHandle {
  /** Feed text chunks from the agent stream. */
  onText: (text: string) => void;
  /** Called once the agent finishes successfully. Posts the final response. */
  finalize: (
    fullText: string,
    tokenInfo?: { input: number; output: number },
  ) => Promise<void>;
  /** Called when the agent errors out. Updates the thinking message with the error. */
  onError: (err: unknown) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum accumulated characters before we push a progressive update. */
const STREAM_UPDATE_THRESHOLD = 1500;

/** Minimum time (ms) between progressive Slack updates to avoid rate-limits. */
const MIN_UPDATE_INTERVAL_MS = 1200;

// ---------------------------------------------------------------------------
// Cost estimation (Claude Opus 4.6 pricing: $5/M input, $25/M output)
// ---------------------------------------------------------------------------

function estimateCost(inputTokens: number, outputTokens: number): string {
  const cost =
    (inputTokens * 5) / 1_000_000 + (outputTokens * 25) / 1_000_000;
  return cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2);
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();

    if (msg.includes('rate') || msg.includes('429')) {
      return 'Rate limit exceeded. Please wait a moment and try again.';
    }
    if (msg.includes('auth') || msg.includes('401') || msg.includes('permission')) {
      return 'Authentication error. The API key may be invalid or expired.';
    }
    if (msg.includes('timeout') || msg.includes('timed out')) {
      return 'Request timed out. Please try again.';
    }
    if (msg.includes('overloaded') || msg.includes('529')) {
      return 'The AI service is overloaded. Please try again in a moment.';
    }
    if (msg.includes('invalid') || msg.includes('400')) {
      return 'Invalid request. The message may be too long or contain unsupported content.';
    }
    if (msg.includes('context') || msg.includes('token')) {
      return 'Context length exceeded. Try a shorter message or start a new thread.';
    }

    return `Unexpected error: ${err.message}`;
  }

  return 'An unknown error occurred. Please try again.';
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStreamResponder(
  options: StreamResponderOptions,
): StreamResponderHandle {
  const { client, channel, threadTs, userMessageTs, agentName } = options;

  let thinkingTs: string | undefined;
  let accumulated = '';
  let lastUpdateLen = 0;
  let lastUpdateTime = 0;
  let updateInFlight = false;

  // ------ helpers ----------------------------------------------------------

  async function addReaction(name: string, ts: string): Promise<void> {
    try {
      await client.reactions.add({ channel, name, timestamp: ts });
    } catch {
      // Reaction may already exist or message may be gone - not critical
    }
  }

  async function removeReaction(name: string, ts: string): Promise<void> {
    try {
      await client.reactions.remove({ channel, name, timestamp: ts });
    } catch {
      // Reaction may not exist - not critical
    }
  }

  async function postThinking(): Promise<void> {
    const res = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `:hourglass_flowing_sand: *${agentName}* is thinking...`,
    });
    thinkingTs = res.ts as string;
  }

  async function updateMessage(text: string): Promise<void> {
    if (!thinkingTs) return;
    await client.chat.update({
      channel,
      ts: thinkingTs,
      text,
    });
  }

  // ------ progressive streaming --------------------------------------------

  function pushProgressiveUpdate(): void {
    if (updateInFlight) return;

    const now = Date.now();
    const delta = accumulated.length - lastUpdateLen;
    const elapsed = now - lastUpdateTime;

    if (delta < STREAM_UPDATE_THRESHOLD) return;
    if (elapsed < MIN_UPDATE_INTERVAL_MS) return;

    updateInFlight = true;
    lastUpdateLen = accumulated.length;
    lastUpdateTime = now;

    const partialMrkdwn = markdownToMrkdwn(accumulated);
    const preview = `${partialMrkdwn}\n\n:hourglass_flowing_sand: _${agentName} is still typing..._`;

    updateMessage(preview)
      .catch((err: unknown) => {
        logger.warn({ err }, 'Failed to push progressive update');
      })
      .finally(() => {
        updateInFlight = false;
      });
  }

  // ------ public API -------------------------------------------------------

  // Kick off the thinking indicator and reaction immediately.
  // We store the promise so finalize/onError can await it before
  // attempting to update the thinking message.
  const setupPromise = (async () => {
    await Promise.all([
      postThinking(),
      addReaction('hourglass_flowing_sand', userMessageTs),
    ]);
  })();

  const onText = (text: string): void => {
    accumulated += text;
    pushProgressiveUpdate();
  };

  const finalize = async (
    fullText: string,
    tokenInfo?: { input: number; output: number },
  ): Promise<void> => {
    await setupPromise;

    const mrkdwn = markdownToMrkdwn(fullText);
    const totalTokens = tokenInfo ? tokenInfo.input + tokenInfo.output : undefined;
    const costEstimate = tokenInfo
      ? estimateCost(tokenInfo.input, tokenInfo.output)
      : undefined;
    const footer =
      totalTokens !== undefined
        ? `\n_${agentName} · ${totalTokens.toLocaleString()} tokens${costEstimate ? ` (~$${costEstimate})` : ''}_`
        : '';

    const fullContent = `${mrkdwn}${footer}`;
    const chunks = chunkMessage(fullContent);

    // Update the thinking message with the first chunk.
    if (chunks[0]) {
      await updateMessage(chunks[0]);
    }

    // Post remaining chunks as follow-up messages in the thread.
    for (let i = 1; i < chunks.length; i++) {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: chunks[i]!,
      });
    }

    // Remove the hourglass reaction.
    await removeReaction('hourglass_flowing_sand', userMessageTs);
  };

  const onError = async (err: unknown): Promise<void> => {
    await setupPromise;

    const description = classifyError(err);
    const errorText = `:x: *${agentName}* ran into a problem.\n${description}`;

    await updateMessage(errorText);
    await removeReaction('hourglass_flowing_sand', userMessageTs);
  };

  return { onText, finalize, onError };
}
