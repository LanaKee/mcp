import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadDemoData } from "./data-store.js";
import { createHttpApp } from "./http.js";
import {
  BoundedTokenBucketRateLimiter,
  loadHttpSecurityConfig
} from "./http-security.js";
import {
  loadMcpHttpConfig,
  McpSessionManager,
  mcpSessionId
} from "./mcp-http.js";
import { mcpCorrelationId } from "./mcp-server.js";
import { InMemoryDataRepository } from "./repository.js";
import { createToolRegistry, type ToolRegistry } from "./tools.js";

const MCP_ACCEPT = "application/json, text/event-stream";

let baseUrl = "";
let server: ReturnType<typeof createHttpApp>;
let sessions: McpSessionManager;
let registry: ToolRegistry;

beforeAll(async () => {
  const store = await loadDemoData();
  registry = createToolRegistry(new InMemoryDataRepository(store));
  sessions = new McpSessionManager(loadMcpHttpConfig({}));
  server = createHttpApp(registry, { mcpSessions: sessions });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await sessions.closeAll();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

async function connect(): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`)
  );
  await client.connect(transport);
  return { client, transport };
}

function rpc(
  method: string,
  extraHeaders: Record<string, string> = {},
  id: number | string = 1
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: MCP_ACCEPT,
      ...extraHeaders
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method })
  });
}

describe("hosted MCP endpoint", () => {
  it("completes an initialize handshake and issues a session id", async () => {
    const { client, transport } = await connect();
    expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessions.has(transport.sessionId!)).toBe(true);
    await transport.terminateSession();
    await client.close();
  });

  it("exposes the same tool surface as the stdio server", async () => {
    const { client, transport } = await connect();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      Object.keys(registry.tools).sort()
    );
    await transport.terminateSession();
    await client.close();
  });

  it("routes a tool call and always answers with a data_status", async () => {
    const { client, transport } = await connect();
    const result = await client.callTool({
      name: "get_population_trend",
      arguments: { region: "포항시", startYear: 2022, endYear: 2024 }
    });
    const text = (result.content as { text: string }[])[0].text;
    const payload = JSON.parse(text) as Record<string, unknown>;
    expect(payload).toHaveProperty("data_status");
    // The in-memory fixture is demo-only and demo rows are excluded at
    // runtime, so this must never come back as if it were observed data.
    expect(payload.data_status).not.toBe("official_observed");
    expect(text).not.toContain("demo_sample");
    await transport.terminateSession();
    await client.close();
  });

  it("reports tool failures as MCP errors without fabricating data", async () => {
    const { client, transport } = await connect();
    const result = await client.callTool({
      name: "get_population_trend",
      arguments: { region: "존재하지않는시" }
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content as { text: string }[])[0].text);
    expect(payload.data_status).toBe("empty");
    expect(payload.data_statuses).toEqual([]);
    expect(payload.error).toBeTruthy();
    await transport.terminateSession();
    await client.close();
  });

  it("reuses a session across separate requests", async () => {
    const { client, transport } = await connect();
    const before = sessions.size;
    await client.listTools();
    await client.listTools();
    expect(sessions.size).toBe(before);
    await transport.terminateSession();
    await client.close();
  });

  it("releases the session on DELETE", async () => {
    const { client, transport } = await connect();
    const sessionId = transport.sessionId!;
    expect(sessions.has(sessionId)).toBe(true);
    await transport.terminateSession();
    await client.close();
    expect(sessions.has(sessionId)).toBe(false);
  });

  it("rejects an unknown session instead of silently opening a new one", async () => {
    const response = await rpc("tools/list", {
      "mcp-session-id": "11111111-2222-3333-4444-555555555555"
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32001);
  });

  it("rejects a non-initialize request that carries no session", async () => {
    const response = await rpc("tools/list");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32000);
  });

  it("rejects non-JSON payloads", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not json"
    });
    expect(response.status).toBe(415);
  });

  it("rejects unsupported HTTP methods", async () => {
    const response = await fetch(`${baseUrl}/mcp`, { method: "PUT" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("POST");
  });
});

describe("MCP session manager", () => {
  it("refuses new sessions past the configured cap", async () => {
    const manager = new McpSessionManager({
      maxSessions: 1,
      sessionIdleMs: 60_000,
      allowedHosts: [],
      allowedOrigins: []
    });
    const capped = createHttpApp(registry, { mcpSessions: manager });
    await new Promise<void>((resolve) =>
      capped.listen(0, "127.0.0.1", resolve)
    );
    const url = new URL(
      `http://127.0.0.1:${(capped.address() as AddressInfo).port}/mcp`
    );
    const first = new Client({ name: "a", version: "1.0.0" });
    const firstTransport = new StreamableHTTPClientTransport(url);
    await first.connect(firstTransport);
    expect(manager.size).toBe(1);

    const second = new Client({ name: "b", version: "1.0.0" });
    await expect(
      second.connect(new StreamableHTTPClientTransport(url))
    ).rejects.toThrow();
    expect(manager.size).toBe(1);

    await firstTransport.terminateSession();
    await first.close();
    await manager.closeAll();
    await new Promise<void>((resolve) => capped.close(() => resolve()));
  });

  it("evicts sessions that have been idle past the deadline", async () => {
    let clock = 1_000;
    const manager = new McpSessionManager(
      {
        maxSessions: 8,
        sessionIdleMs: 5_000,
        allowedHosts: [],
        allowedOrigins: []
      },
      () => clock
    );
    const hosted = createHttpApp(registry, { mcpSessions: manager });
    await new Promise<void>((resolve) =>
      hosted.listen(0, "127.0.0.1", resolve)
    );
    const client = new Client({ name: "idle", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(
        `http://127.0.0.1:${(hosted.address() as AddressInfo).port}/mcp`
      )
    );
    await client.connect(transport);
    expect(manager.size).toBe(1);

    clock += 1_000;
    expect(manager.evictIdle()).toBe(0);
    expect(manager.size).toBe(1);

    clock += 10_000;
    expect(manager.evictIdle()).toBe(1);
    expect(manager.size).toBe(0);

    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => hosted.close(() => resolve()));
  });

  it("keeps an actively used session alive across the idle deadline", () => {
    let clock = 1_000;
    const manager = new McpSessionManager(
      {
        maxSessions: 8,
        sessionIdleMs: 5_000,
        allowedHosts: [],
        allowedOrigins: []
      },
      () => clock
    );
    const fake = {
      transport: { close: async () => undefined },
      close: async () => undefined,
      lastSeenAt: clock
    };
    (manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
      "s1",
      fake
    );
    clock += 4_000;
    manager.touch("s1");
    clock += 4_000;
    expect(manager.evictIdle()).toBe(0);
    expect(manager.size).toBe(1);
  });

  it("closes every session during shutdown", async () => {
    const manager = new McpSessionManager(loadMcpHttpConfig({}));
    const hosted = createHttpApp(registry, { mcpSessions: manager });
    await new Promise<void>((resolve) =>
      hosted.listen(0, "127.0.0.1", resolve)
    );
    const url = new URL(
      `http://127.0.0.1:${(hosted.address() as AddressInfo).port}/mcp`
    );
    const client = new Client({ name: "drain", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    expect(manager.size).toBe(1);
    await manager.closeAll();
    expect(manager.size).toBe(0);
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => hosted.close(() => resolve()));
  });
});

describe("MCP hosting configuration", () => {
  it("falls back to safe defaults", () => {
    const config = loadMcpHttpConfig({});
    expect(config.maxSessions).toBe(256);
    expect(config.sessionIdleMs).toBe(600_000);
    expect(config.allowedHosts).toEqual([]);
  });

  it("parses overrides and allow-lists", () => {
    const config = loadMcpHttpConfig({
      MCP_MAX_SESSIONS: "4",
      MCP_SESSION_IDLE_MS: "1000",
      MCP_ALLOWED_HOSTS: "mcp.example.org, localhost:8787",
      MCP_ALLOWED_ORIGINS: "https://mcp.example.org"
    });
    expect(config.maxSessions).toBe(4);
    expect(config.sessionIdleMs).toBe(1000);
    expect(config.allowedHosts).toEqual(["mcp.example.org", "localhost:8787"]);
    expect(config.allowedOrigins).toEqual(["https://mcp.example.org"]);
  });

  it("rejects nonsensical limits rather than silently ignoring them", () => {
    expect(() => loadMcpHttpConfig({ MCP_MAX_SESSIONS: "0" })).toThrow(
      /MCP_MAX_SESSIONS/
    );
    expect(() => loadMcpHttpConfig({ MCP_SESSION_IDLE_MS: "abc" })).toThrow(
      /MCP_SESSION_IDLE_MS/
    );
  });
});

describe("mcpSessionId", () => {
  it("reads the session header and ignores empty values", () => {
    expect(
      mcpSessionId({ headers: { "mcp-session-id": "abc" } } as never)
    ).toBe("abc");
    expect(mcpSessionId({ headers: {} } as never)).toBeUndefined();
    expect(
      mcpSessionId({ headers: { "mcp-session-id": "" } } as never)
    ).toBeUndefined();
  });
});

describe("mcpCorrelationId", () => {
  it("always satisfies the audit table's correlation format", () => {
    const pattern = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;
    expect(mcpCorrelationId("session-abc", 2)).toMatch(pattern);
    expect(mcpCorrelationId(undefined, 1)).toMatch(pattern);
    expect(mcpCorrelationId(undefined, undefined)).toMatch(pattern);
    expect(mcpCorrelationId("x", 0)).toMatch(pattern);
    expect(mcpCorrelationId("a".repeat(200), 99).length).toBeLessThanOrEqual(
      64
    );
  });

  it("keeps concurrent sessions from colliding on the same request id", () => {
    expect(mcpCorrelationId("session-a", 1)).not.toBe(
      mcpCorrelationId("session-b", 1)
    );
  });
});

describe("hosted MCP rate limiting", () => {
  it("charges expensive tool calls to the expensive budget while letting protocol traffic through", async () => {
    const security = loadHttpSecurityConfig({
      HTTP_RATE_LIMIT_EXPENSIVE_PER_MINUTE: "1",
      HTTP_RATE_LIMIT_CHEAP_PER_MINUTE: "1000"
    });
    const manager = new McpSessionManager(loadMcpHttpConfig({}));
    const limited = createHttpApp(registry, {
      security,
      rateLimiter: new BoundedTokenBucketRateLimiter(security),
      mcpSessions: manager
    });
    await new Promise<void>((resolve) =>
      limited.listen(0, "127.0.0.1", resolve)
    );
    const endpoint = `http://127.0.0.1:${
      (limited.address() as AddressInfo).port
    }/mcp`;
    const client = new Client({ name: "limited", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint));
    await client.connect(transport);
    const sessionId = transport.sessionId!;

    const callExpensive = () =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: MCP_ACCEPT,
          "mcp-session-id": sessionId
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "search_council_records", arguments: { query: "예산" } }
        })
      });

    expect((await callExpensive()).status).toBe(200);
    const throttled = await callExpensive();
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBeTruthy();

    // The expensive budget is exhausted, but the session must still be able to
    // speak the protocol, otherwise one heavy call would kill the connection.
    const chatter = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: MCP_ACCEPT,
        "mcp-session-id": sessionId
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    });
    expect(chatter.status).toBe(200);

    await transport.terminateSession();
    await client.close();
    await manager.closeAll();
    await new Promise<void>((resolve) => limited.close(() => resolve()));
  });
});

describe("hosted MCP authentication", () => {
  it("requires a token when token auth is enabled", async () => {
    const token = "hosted-mcp-test-token-0123456789";
    const security = loadHttpSecurityConfig({
      HTTP_AUTH_MODE: "token",
      HTTP_AUTH_TOKEN: token
    });
    const manager = new McpSessionManager(loadMcpHttpConfig({}));
    const guarded = createHttpApp(registry, {
      security,
      mcpSessions: manager
    });
    await new Promise<void>((resolve) =>
      guarded.listen(0, "127.0.0.1", resolve)
    );
    const endpoint = `http://127.0.0.1:${
      (guarded.address() as AddressInfo).port
    }/mcp`;

    const anonymous = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    expect(anonymous.status).toBe(401);
    expect(manager.size).toBe(0);

    const client = new Client({ name: "authed", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    });
    await client.connect(transport);
    expect(manager.size).toBe(1);

    await transport.terminateSession();
    await client.close();
    await manager.closeAll();
    await new Promise<void>((resolve) => guarded.close(() => resolve()));
  });
});
