import { isIP } from "node:net";
import { createHttpApp } from "./http.js";
import { loadHttpSecurityConfig } from "./http-security.js";
import { loadMcpHttpConfig, McpSessionManager } from "./mcp-http.js";
import { startStdioServer } from "./mcp.js";
import {
  createDataRepository,
  loadRepositoryEnvironment
} from "./runtime.js";
import { createToolRegistry } from "./tools.js";

const mode = process.argv.includes("--stdio") ? "stdio" : "http";
loadRepositoryEnvironment();
const httpSecurity = mode === "http" ? loadHttpSecurityConfig() : undefined;
const httpHost =
  mode === "http" ? (process.env.HTTP_HOST ?? "127.0.0.1") : undefined;
if (httpHost && isIP(httpHost) === 0) {
  throw new Error("HTTP_HOST must be an IPv4 or IPv6 address");
}
const repository = await createDataRepository();
const registry = createToolRegistry(repository);

if (mode === "stdio") {
  const server = await startStdioServer(registry);
  const shutdown = async () => {
    await server.close().catch(() => undefined);
    await repository.close().catch(() => undefined);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
} else {
  const port = Number(process.env.PORT ?? 8787);
  const mcpConfig = loadMcpHttpConfig();
  const mcpSessions = new McpSessionManager(mcpConfig);
  // Clients that vanish never send DELETE, so idle sessions are reaped on a
  // timer rather than only when the next request happens to arrive.
  const sweep = setInterval(
    () => mcpSessions.evictIdle(),
    Math.max(1000, Math.floor(mcpConfig.sessionIdleMs / 2))
  );
  sweep.unref();
  const server = createHttpApp(registry, {
    security: httpSecurity,
    mcpSessions
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(sweep);
    // Streamable HTTP holds long-lived SSE responses open, so they have to be
    // closed before the listener will finish closing.
    await mcpSessions.closeAll().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await repository.close().catch(() => undefined);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  server.listen(port, httpHost!, () => {
    console.log(
      `gyeongbuk-public-ai HTTP server listening on http://${httpHost}:${port} (${repository.mode})`
    );
    console.log(
      `MCP Streamable HTTP endpoint: http://${httpHost}:${port}/mcp`
    );
  });
}
