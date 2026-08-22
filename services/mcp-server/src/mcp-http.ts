import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./mcp-server.js";
import type { ToolRegistry } from "./tools.js";

export interface McpHttpConfig {
  /** Rejects new sessions past this point so a hosted process cannot be OOMed. */
  maxSessions: number;
  /** Sessions idle for longer than this are reaped on the next sweep. */
  sessionIdleMs: number;
  /**
   * Host/Origin allow-lists for DNS rebinding protection. Empty means the
   * check is disabled, which is only appropriate behind a trusted proxy.
   */
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
}

export function loadMcpHttpConfig(
  env: NodeJS.ProcessEnv = process.env
): McpHttpConfig {
  return {
    maxSessions: positiveInteger(env.MCP_MAX_SESSIONS, 256, "MCP_MAX_SESSIONS"),
    sessionIdleMs: positiveInteger(
      env.MCP_SESSION_IDLE_MS,
      10 * 60 * 1000,
      "MCP_SESSION_IDLE_MS"
    ),
    allowedHosts: csv(env.MCP_ALLOWED_HOSTS),
    allowedOrigins: csv(env.MCP_ALLOWED_ORIGINS)
  };
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function csv(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
  lastSeenAt: number;
}

export class McpSessionLimitError extends Error {
  constructor(readonly limit: number) {
    super(`MCP session limit of ${limit} reached`);
    this.name = "McpSessionLimitError";
  }
}

/**
 * Owns the lifetime of hosted MCP sessions.
 *
 * A hosted server keeps per-session state in memory, so the two failure modes
 * that matter are unbounded growth and sessions that are never closed by a
 * client that simply disappeared. Both are handled here rather than in the
 * request path.
 */
export class McpSessionManager {
  private readonly sessions = new Map<string, McpSession>();

  constructor(
    private readonly config: McpHttpConfig,
    private readonly now: () => number = Date.now
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  touch(sessionId: string): StreamableHTTPServerTransport | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.lastSeenAt = this.now();
    return session.transport;
  }

  async create(registry: ToolRegistry): Promise<StreamableHTTPServerTransport> {
    this.evictIdle();
    if (this.sessions.size >= this.config.maxSessions) {
      throw new McpSessionLimitError(this.config.maxSessions);
    }
    const dnsProtection =
      this.config.allowedHosts.length > 0 ||
      this.config.allowedOrigins.length > 0;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: dnsProtection,
      ...(this.config.allowedHosts.length > 0
        ? { allowedHosts: [...this.config.allowedHosts] }
        : {}),
      ...(this.config.allowedOrigins.length > 0
        ? { allowedOrigins: [...this.config.allowedOrigins] }
        : {}),
      onsessioninitialized: (sessionId) => {
        this.sessions.set(sessionId, {
          transport,
          close: async () => {
            await server.close().catch(() => undefined);
          },
          lastSeenAt: this.now()
        });
      }
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    const server = createMcpServer(registry);
    await server.connect(transport);
    return transport;
  }

  evictIdle(): number {
    const deadline = this.now() - this.config.sessionIdleMs;
    let evicted = 0;
    for (const [sessionId, session] of this.sessions) {
      if (session.lastSeenAt > deadline) continue;
      this.sessions.delete(sessionId);
      evicted += 1;
      void session.transport.close().catch(() => undefined);
      void session.close().catch(() => undefined);
    }
    return evicted;
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map(async (session) => {
        await session.transport.close().catch(() => undefined);
        await session.close().catch(() => undefined);
      })
    );
  }
}

export function mcpSessionId(request: IncomingMessage): string | undefined {
  const header = request.headers["mcp-session-id"];
  const value = Array.isArray(header) ? header[0] : header;
  return value && value.length > 0 ? value : undefined;
}

export interface McpRequestOutcome {
  status: "handled" | "rejected";
  reason?: "session_limit" | "unknown_session" | "missing_session";
}

/**
 * Routes one Streamable HTTP request to its session transport.
 *
 * POST without a session id must be an `initialize` call; anything else is a
 * client that lost its session, and answering it with a fresh one would
 * silently discard the state it believes it has.
 */
export async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  registry: ToolRegistry,
  sessions: McpSessionManager,
  parsedBody?: unknown
): Promise<McpRequestOutcome> {
  const sessionId = mcpSessionId(request);

  if (sessionId) {
    const transport = sessions.touch(sessionId);
    if (!transport) {
      respondJsonRpcError(
        response,
        404,
        -32001,
        "Unknown or expired MCP session. Re-initialize to continue."
      );
      return { status: "rejected", reason: "unknown_session" };
    }
    await transport.handleRequest(request, response, parsedBody);
    return { status: "handled" };
  }

  if (request.method !== "POST" || !isInitializeRequest(parsedBody)) {
    respondJsonRpcError(
      response,
      400,
      -32000,
      "Missing mcp-session-id header. Send an initialize request first."
    );
    return { status: "rejected", reason: "missing_session" };
  }

  let transport: StreamableHTTPServerTransport;
  try {
    transport = await sessions.create(registry);
  } catch (error) {
    if (error instanceof McpSessionLimitError) {
      response.setHeader("retry-after", "30");
      respondJsonRpcError(
        response,
        503,
        -32000,
        "MCP session capacity reached. Retry shortly."
      );
      return { status: "rejected", reason: "session_limit" };
    }
    throw error;
  }
  await transport.handleRequest(request, response, parsedBody);
  return { status: "handled" };
}

function respondJsonRpcError(
  response: ServerResponse,
  status: number,
  code: number,
  message: string
): void {
  if (response.headersSent) return;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message },
    id: null
  });
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}
