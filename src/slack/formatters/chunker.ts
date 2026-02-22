/**
 * Default maximum length per Slack message chunk.
 * Slack's hard limit is 4000 chars but 3000 leaves headroom for metadata.
 */
const DEFAULT_MAX_LENGTH = 3000;

/**
 * Split text into chunks that fit within Slack's message length limit.
 *
 * Splitting strategy (in order of preference):
 * 1. Paragraph boundaries (double newline)
 * 2. Sentence boundaries (period/exclamation/question followed by space)
 * 3. Word boundaries (space)
 * 4. Hard cut as last resort
 *
 * Code blocks (``` ... ```) are never split in the middle.
 */
export function chunkMessage(text: string, maxLength = DEFAULT_MAX_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const cutPoint = findCutPoint(remaining, maxLength);
    chunks.push(remaining.slice(0, cutPoint).trimEnd());
    remaining = remaining.slice(cutPoint).trimStart();
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Find the best position to cut the text at or before `maxLength`.
 *
 * Ensures we never split inside a code block.
 */
function findCutPoint(text: string, maxLength: number): number {
  const window = text.slice(0, maxLength);

  // Check if we would be splitting inside a code block
  const codeBlockSafe = findCodeBlockSafeCut(window, text, maxLength);
  if (codeBlockSafe !== -1) {
    return codeBlockSafe;
  }

  // 1. Try paragraph boundary (double newline)
  const paragraphCut = findLastOccurrence(window, "\n\n");
  if (paragraphCut > maxLength * 0.3) {
    return paragraphCut + 2; // include the double newline in the current chunk
  }

  // 2. Try single newline
  const newlineCut = findLastOccurrence(window, "\n");
  if (newlineCut > maxLength * 0.3) {
    return newlineCut + 1;
  }

  // 3. Try sentence boundary
  const sentenceCut = findLastSentenceBoundary(window);
  if (sentenceCut > maxLength * 0.3) {
    return sentenceCut;
  }

  // 4. Try word boundary
  const spaceCut = window.lastIndexOf(" ");
  if (spaceCut > maxLength * 0.3) {
    return spaceCut + 1;
  }

  // 5. Hard cut as last resort
  return maxLength;
}

/**
 * If we're about to cut inside a code block, return the position just
 * before the code block starts.  Returns -1 if we're not inside a code
 * block or the block ends within the window.
 */
function findCodeBlockSafeCut(
  window: string,
  fullText: string,
  maxLength: number,
): number {
  // Count opening and closing ``` fences in the window
  const fenceRegex = /```/g;
  const fences: number[] = [];
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(window)) !== null) {
    fences.push(match.index);
  }

  // If even number of fences, we're not inside a code block
  if (fences.length % 2 === 0) {
    return -1;
  }

  // Odd number of fences means we're inside an unclosed block.
  // Find the closing ``` in the full text after the last opening fence.
  const lastOpenFence = fences[fences.length - 1]!;
  const closingFence = fullText.indexOf("```", lastOpenFence + 3);

  if (closingFence !== -1 && closingFence + 3 <= maxLength * 2) {
    // The block closes within a reasonable range - include the whole block
    return closingFence + 3;
  }

  // Otherwise, cut before the opening fence
  if (lastOpenFence > 0) {
    return lastOpenFence;
  }

  return -1;
}

function findLastOccurrence(text: string, needle: string): number {
  return text.lastIndexOf(needle);
}

/**
 * Find the last sentence boundary (. ! ? followed by a space or end of string).
 */
function findLastSentenceBoundary(text: string): number {
  // Search backwards for sentence-ending punctuation followed by whitespace
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if ((ch === "." || ch === "!" || ch === "?") && (i + 1 >= text.length || text[i + 1] === " " || text[i + 1] === "\n")) {
      return i + 1;
    }
  }
  return -1;
}
