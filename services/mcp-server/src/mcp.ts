import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp-server.js";
import type { ToolRegistry } from "./tools.js";

export async function startStdioServer(registry: ToolRegistry) {
  const server = createMcpServer(registry);
  await server.connect(new StdioServerTransport());
  return server;
}
