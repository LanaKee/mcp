import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { executeTool, type ToolDefinition } from "./tools.js";

export async function startStdioServer(registry: Record<string, ToolDefinition>) {
  const server = new Server(
    { name: "gyeongbuk-public-ai", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(registry).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await executeTool(
        registry,
        request.params.name,
        request.params.arguments ?? {}
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
              data_status: "demo_sample",
              error: error instanceof Error ? error.message : String(error)
            })
          }
        ]
      };
    }
  });
  await server.connect(new StdioServerTransport());
}

