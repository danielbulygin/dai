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
  // First pass: convert markdown tables to code blocks (Slack can't render pipe tables)
  const withTables = convertTables(markdown);

  const lines = withTables.split("\n");
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
 * Convert markdown pipe tables into monospace code blocks.
 * Detects consecutive lines starting with `|`, strips delimiters and
 * separator rows, pads columns, and wraps in triple backticks.
 */
function convertTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const currentLine = lines[i]!;
    if (currentLine.trimStart().startsWith("|")) {
      // Collect all consecutive table lines
      const tableLines: string[] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith("|")) {
        tableLines.push(lines[i]!);
        i++;
      }

      // Parse cells from each row
      const rows: string[][] = [];
      for (const tl of tableLines) {
        // Skip separator rows like |---|---|
        if (/^\s*\|[\s:|-]+\|\s*$/.test(tl)) continue;
        const cells = tl
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((c) => c.trim());
        rows.push(cells);
      }

      if (rows.length === 0) {
        // Only separator rows — keep as-is
        result.push(...tableLines);
        continue;
      }

      // Calculate max width per column
      const colCount = Math.max(...rows.map((r) => r.length));
      const widths: number[] = Array.from<number>({ length: colCount }).fill(0);
      for (const row of rows) {
        for (let c = 0; c < colCount; c++) {
          widths[c] = Math.max(widths[c]!, (row[c] ?? "").length);
        }
      }

      // Build padded lines
      result.push("```");
      for (const row of rows) {
        const padded = widths.map((w, c) => (row[c] ?? "").padEnd(w));
        result.push(padded.join("  "));
      }
      result.push("```");
    } else {
      result.push(currentLine);
      i++;
    }
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
