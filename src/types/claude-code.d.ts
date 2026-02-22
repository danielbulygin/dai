declare module "@anthropic-ai/claude-code" {
  export interface Message {
    role: "user" | "assistant";
    content: string | Array<{ type: string; text?: string }>;
  }

  export interface QueryOptions {
    prompt: Message[];
    systemPrompt: string;
    options?: {
      maxTurns?: number;
      allowedTools?: string[];
    };
    abortController?: AbortController;
  }

  export function query(options: QueryOptions): AsyncIterable<Message>;
}
