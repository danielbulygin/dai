/**
 * Tool bridge — turns dai's existing tool registry into a single in-process
 * Agent-SDK MCP server.
 *
 * Each dai tool is `{ definition: Anthropic.Tool, execute(input, ctx) }`. We
 * wrap every tool in a profile as an SDK `tool()` whose handler routes back
 * through dai's `executeTool()` dispatcher — so we keep the existing audit
 * logging (`piper_actions`), soft-failure detection, and clientScope overrides
 * for free. The `ToolContext` (channel/user/thread/clientScope) is injected
 * per-query via a closure, exactly as the plan describes.
 *
 * The model sees these tools as `mcp__<serverName>__<toolName>`.
 *
 * Part of the Phase-B Agent-SDK spike — additive, does not modify the runner.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { getToolsForProfile, executeTool } from '../tool-registry.js';
import type { ToolContext } from '../tool-registry.js';
import type { ToolProfile } from '../profiles/index.js';
import { jsonSchemaToZodRawShape } from './schema.js';
import { surfaceWriteFailure } from './observe-after.js';

export const ADA_MCP_SERVER_NAME = 'ada-tools';

/** Fully-qualified tool name as the model/permission-system sees it. */
export function mcpToolName(toolName: string, serverName = ADA_MCP_SERVER_NAME): string {
  return `mcp__${serverName}__${toolName}`;
}

export interface ToolBridge {
  /** The in-process MCP server config to pass into `query({ options: { mcpServers } })`. */
  server: ReturnType<typeof createSdkMcpServer>;
  serverName: string;
  /** Bare dai tool names included (e.g. `query_meta_insights`). */
  toolNames: string[];
  /** Fully-qualified names (e.g. `mcp__ada-tools__query_meta_insights`). */
  qualifiedToolNames: string[];
}

export interface BuildBridgeOptions {
  /** Returns the live ToolContext for the current query (closure injection). */
  getContext: () => ToolContext;
  /** Optional: restrict to a subset of the profile's tools (spike convenience). */
  only?: string[];
  /** Optional: fired when a tool starts executing (progress / onToolUse). */
  onToolExec?: (toolName: string) => void;
  /**
   * Governor gate (Ada 2.0): score a WRITE before it executes. When the result
   * carries a `refusal`, the bridge does NOT execute and returns it as an
   * isError result (the model sees exactly why + what to do instead).
   */
  govern?: (toolName: string) => { refusal?: string } | undefined;
  /**
   * Failure organ (Ada 2.0): called when a tool result is a failure. Returns a
   * note (documented fix from ada_dead_ends) appended to the model-visible
   * error, or undefined when the failure is unknown.
   */
  onToolFailure?: (toolName: string, resultText: string) => Promise<string | undefined>;
  /** Outcome tracker (Ada 2.0 run-state: confidence escalation, probe tracking). */
  onToolOutcome?: (toolName: string, failed: boolean) => void;
  serverName?: string;
}

/**
 * Build the Ada tool MCP server from a dai profile.
 */
export function buildAdaToolBridge(
  profile: ToolProfile,
  opts: BuildBridgeOptions,
): ToolBridge {
  const serverName = opts.serverName ?? ADA_MCP_SERVER_NAME;
  const { definitions } = getToolsForProfile(profile);

  const selected = opts.only
    ? definitions.filter((d) => opts.only!.includes(d.name))
    : definitions;

  const tools = selected.map((def) =>
    tool(
      def.name,
      def.description ?? '',
      jsonSchemaToZodRawShape(def.input_schema),
      async (args: Record<string, unknown>) => {
        opts.onToolExec?.(def.name);
        // The Governor (Ada 2.0): a write scored 'blocked' or 'options' never
        // executes — the model gets the verdict + guidance as an error result.
        const gate = opts.govern?.(def.name);
        if (gate?.refusal) {
          return { content: [{ type: 'text' as const, text: gate.refusal }], isError: true };
        }
        const { result, isError } = await executeTool(
          def.name,
          (args ?? {}) as Record<string, unknown>,
          opts.getContext(),
        );
        // Observe-after: a failed WRITE must reach the model as an error, not a
        // narratable success (the structural fix for streams-success-on-failure).
        const failed = surfaceWriteFailure(def.name, result, isError);
        // Failure organ: on a failure, look the error up in ada_dead_ends and
        // hand the model the documented fix inline (look yourself up first).
        let text = result;
        if (failed && opts.onToolFailure) {
          try {
            const note = await opts.onToolFailure(def.name, result);
            if (note) text = `${result}\n\n${note}`;
          } catch { /* fail-soft: the raw error still reaches the model */ }
        }
        opts.onToolOutcome?.(def.name, failed);
        return {
          content: [{ type: 'text' as const, text }],
          isError: failed,
        };
      },
    ),
  );

  const server = createSdkMcpServer({ name: serverName, tools });
  const toolNames = selected.map((d) => d.name);

  return {
    server,
    serverName,
    toolNames,
    qualifiedToolNames: toolNames.map((n) => mcpToolName(n, serverName)),
  };
}
