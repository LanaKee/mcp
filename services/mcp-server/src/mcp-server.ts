import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { executeTool, type ToolRegistry } from "./tools.js";

export const MCP_SERVER_NAME = "gyeongbuk-public-ai";
export const MCP_SERVER_VERSION = "0.1.0";

/**
 * JSON-RPC request ids are frequently small integers, but `mcp_tool_audit`
 * requires a correlation id of at least 8 characters. Qualifying the id with
 * the session keeps calls traceable and keeps concurrent sessions from
 * colliding on the same counter.
 */
export function mcpCorrelationId(
  sessionId: string | undefined,
  requestId: string | number | undefined
): string {
  const scope = (sessionId ?? randomUUID()).replace(/[^A-Za-z0-9._-]/g, "");
  const suffix = requestId === undefined ? "" : `-${String(requestId)}`;
  return `mcp-${scope}${suffix}`
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 64)
    .padEnd(8, "0");
}

/**
 * Builds an MCP server bound to the tool registry. Both the stdio entry point
 * and the hosted Streamable HTTP endpoint go through here so a remote client
 * cannot observe a different tool surface than a local one.
 */
export function createMcpServer(registry: ToolRegistry): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(registry.tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const result = await executeTool(
        registry,
        request.params.name,
        request.params.arguments ?? {},
        {
          correlationId: mcpCorrelationId(extra?.sessionId, extra?.requestId),
          signal: extra?.signal
        }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              data_status: "empty",
              data_statuses: [],
              error: error instanceof Error ? error.message : String(error)
            })
          }
        ]
      };
    }
  });

  return server;
}
