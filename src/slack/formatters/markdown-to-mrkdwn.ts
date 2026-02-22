/**
 * Convert standard Markdown to Slack's mrkdwn format.
 *
 * Slack's mrkdwn is similar to Markdown but has some key differences:
 * - Bold uses single `*` instead of `**`
 * - Headers become bold text
 * - Links use `<url|text>` syntax
 * - List markers `*` should become `-`
 * - Code blocks and inline code are the same
 * - Blockquotes are the same
 */
export function markdownToMrkdwn(markdown: string): string {
  const lines = markdown.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    // Track code blocks so we don't transform their contents
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    result.push(transformLine(line));
  }

  return result.join("\n");
}

/**
 * Transform a single line of Markdown to mrkdwn.
 * Called only for lines outside of code blocks.
 */
function transformLine(line: string): string {
  let transformed = line;

  // Headers: # Header -> *Header*
  transformed = transformed.replace(
    /^(#{1,6})\s+(.+)$/,
    (_match, _hashes: string, text: string) => `*${text.trim()}*`,
  );

  // Bold: **text** or __text__ -> *text*
  // Must be done before italic to avoid conflicts.
  // Handle **text** (greedy-safe with non-greedy quantifier)
  transformed = transformed.replace(/\*\*(.+?)\*\*/g, "*$1*");
  // Handle __text__
  transformed = transformed.replace(/__(.+?)__/g, "*$1*");

  // Links: [text](url) -> <url|text>
  // Careful not to match image syntax ![alt](url)
  transformed = transformed.replace(
    /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g,
    "<$2|$1>",
  );

  // Images: ![alt](url) -> just the url (Slack auto-unfurls)
  transformed = transformed.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    "$2",
  );

  // Unordered list: `* item` -> `- item` (only at start of line with indent)
  // Don't touch `*bold*` which is bold, only `* ` which is a list marker
  transformed = transformed.replace(/^(\s*)\*\s+/, "$1- ");

  // Horizontal rules: --- or *** or ___ -> ———
  if (/^(\s*)([-*_])\2{2,}\s*$/.test(transformed)) {
    transformed = "———";
  }

  return transformed;
}
