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
        const { result, isError } = await executeTool(
          def.name,
          (args ?? {}) as Record<string, unknown>,
          opts.getContext(),
        );
        return {
          content: [{ type: 'text' as const, text: result }],
          isError,
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
