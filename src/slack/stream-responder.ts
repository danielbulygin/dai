import type { WebClient } from '@slack/web-api';
import Anthropic from '@anthropic-ai/sdk';
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
    tokenInfo?: { input: number; output: number; cacheRead?: number; cacheCreation?: number },
  ) => Promise<void>;
  /** Called when the agent errors out. Updates the thinking message with the error. */
  onError: (err: unknown) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Characters needed before the very first progressive update (show text fast). */
const FIRST_UPDATE_THRESHOLD = 50;

/** Characters accumulated since last update before pushing another update. */
const STREAM_UPDATE_THRESHOLD = 200;

/** Minimum time (ms) between progressive Slack updates to avoid rate-limits. */
const MIN_UPDATE_INTERVAL_MS = 800;

// ---------------------------------------------------------------------------
// Cost estimation (Claude Opus 4.6 pricing)
// Input: $5/M, Output: $25/M, Cache read: $0.50/M, Cache write: $6.25/M
// ---------------------------------------------------------------------------

function estimateCost(
  inputTokens: number,
  outputTokens: number,
  cacheRead = 0,
  cacheCreation = 0,
): string {
  // Non-cached input = total input - cache read - cache creation
  const freshInput = Math.max(0, inputTokens - cacheRead - cacheCreation);
  const cost =
    (freshInput * 5) / 1_000_000 +
    (cacheRead * 0.5) / 1_000_000 +
    (cacheCreation * 6.25) / 1_000_000 +
    (outputTokens * 25) / 1_000_000;
  return cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2);
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function truncate(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function classifyError(err: unknown): string {
  // Use Anthropic SDK error types for precise classification
  if (err instanceof Anthropic.RateLimitError) {
    return 'Rate limit exceeded. Please wait a moment and try again.';
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Authentication error. The API key may be invalid or expired.';
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return 'Request timed out. Please try again.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Connection error. Please try again.';
  }
  if (err instanceof Anthropic.APIError) {
    if (err.status === 529 || /overloaded_error/.test(err.message)) {
      return 'The AI service is overloaded. Please try again in a moment.';
    }
    if (/prompt is too long/.test(err.message)) {
      return 'The data from tool calls was too large. Try asking about a shorter time period or a specific campaign.';
    }
    // Show the actual API error so we can diagnose issues
    return `API error (${err.status}): ${truncate(err.message)}`;
  }
  if (err instanceof Error) {
    return `Error: ${truncate(err.message)}`;
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
  let firstUpdateDone = false;

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

    // First update fires fast (50 chars, no time gate) so the user
    // sees real text replace "is thinking..." as soon as possible.
    const threshold = firstUpdateDone ? STREAM_UPDATE_THRESHOLD : FIRST_UPDATE_THRESHOLD;
    if (delta < threshold) return;
    if (firstUpdateDone && elapsed < MIN_UPDATE_INTERVAL_MS) return;

    firstUpdateDone = true;
    updateInFlight = true;
    lastUpdateLen = accumulated.length;
    lastUpdateTime = now;

    const mrkdwn = markdownToMrkdwn(accumulated);
    const suffix = `\n\n:hourglass_flowing_sand: _${agentName} is still typing..._`;

    // Slack chat.update can hit msg_too_long for large messages.
    // Once the response needs chunking, stop updating the preview — just show progress indicator.
    const SAFE_PREVIEW_LIMIT = 3000;
    let preview: string;
    if (mrkdwn.length > SAFE_PREVIEW_LIMIT) {
      preview = mrkdwn.slice(0, SAFE_PREVIEW_LIMIT) + `\n\n_[... still generating — full response will appear when done]_`;
    } else {
      preview = `${mrkdwn}${suffix}`;
    }

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
    tokenInfo?: { input: number; output: number; cacheRead?: number; cacheCreation?: number },
  ): Promise<void> => {
    await setupPromise;

    const mrkdwn = markdownToMrkdwn(fullText);
    const totalTokens = tokenInfo ? tokenInfo.input + tokenInfo.output : undefined;
    const costEstimate = tokenInfo
      ? estimateCost(tokenInfo.input, tokenInfo.output, tokenInfo.cacheRead, tokenInfo.cacheCreation)
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
