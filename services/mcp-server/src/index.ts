import { isIP } from "node:net";
import { createHttpApp } from "./http.js";
import { createRateLimiter, loadHttpSecurityConfig } from "./http-security.js";
import { loadMcpHttpConfig, McpSessionManager } from "./mcp-http.js";
import { startStdioServer } from "./mcp.js";
import {
  createDataRepository,
  loadRepositoryEnvironment
} from "./runtime.js";
import { createToolRegistry } from "./tools.js";
import { HeuristicPlanner } from "./planner.js";
import { chatClientFromEnv, LlmPlanner } from "./llm-planner.js";
import type { Planner } from "./agent.js";

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
  const rateLimiterHandle = httpSecurity
    ? await createRateLimiter(httpSecurity)
    : undefined;
  // Model-driven planning is an upgrade, never a requirement: with no API key
  // the deterministic planner keeps the agent fully functional, and when a key
  // is present the model still falls back to it on any failure.
  const chat = chatClientFromEnv();
  const heuristicPlanner = new HeuristicPlanner();
  const planner: Planner = chat
    ? new LlmPlanner({
        client: chat.client,
        modelName: chat.modelName,
        fallback: heuristicPlanner
      })
    : heuristicPlanner;
  const server = createHttpApp(registry, {
    security: httpSecurity,
    rateLimiter: rateLimiterHandle?.limiter,
    mcpSessions,
    planner
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
    await rateLimiterHandle?.close().catch(() => undefined);
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
    console.log(`Agent planner: ${planner.name}`);
  });
}
