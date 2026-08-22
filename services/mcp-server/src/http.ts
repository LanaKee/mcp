import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { representativeQuestions, runRepresentativeDemo } from "./demo.js";
import {
  BoundedTokenBucketRateLimiter,
  JsonShapeError,
  clientAddress,
  correlationId,
  isAuthorized,
  loadHttpSecurityConfig,
  validateJsonShape,
  type HttpSecurityConfig,
  type RateLimitGroup
} from "./http-security.js";
import {
  handleMcpRequest,
  loadMcpHttpConfig,
  McpSessionManager
} from "./mcp-http.js";
import { executeTool, type ToolRegistry } from "./tools.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const webCandidates = [
  resolve(moduleDirectory, "../../../apps/web/dist"),
  resolve(moduleDirectory, "../../../apps/web/src")
];
const staticFiles: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/styles.css": "styles.css"
};
export const MCP_ENDPOINT = "/mcp";
const expensiveTools = new Set([
  "search_council_records",
  "search_press_releases",
  "get_source_context",
  "draft_public_document"
]);

export interface HttpAppOptions {
  security?: HttpSecurityConfig;
  rateLimiter?: BoundedTokenBucketRateLimiter;
  /**
   * Hosted MCP sessions. Callers own this so they can drain it during a
   * graceful shutdown; omitting it builds one from the environment.
   */
  mcpSessions?: McpSessionManager;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(code);
  }
}

const securityHeaders: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy":
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
};

function responseHeaders(
  requestId: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    ...securityHeaders,
    "cache-control": "no-store",
    "x-request-id": requestId,
    ...extra
  };
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  requestId: string,
  headers: Record<string, string> = {}
): void {
  response.writeHead(
    status,
    responseHeaders(requestId, {
      "content-type": "application/json; charset=utf-8",
      ...headers
    })
  );
  response.end(JSON.stringify(value));
}

function errorJson(
  response: ServerResponse,
  error: HttpError,
  requestId: string
): void {
  json(
    response,
    error.status,
    {
      error: {
        code: error.code,
        message: error.publicMessage
      },
      request_id: requestId
    },
    requestId,
    error.headers
  );
}

function contentLength(request: IncomingMessage): number | undefined {
  const value = request.headers["content-length"];
  if (value === undefined) return undefined;
  if (Array.isArray(value) || !/^\d+$/.test(value)) {
    throw new HttpError(400, "invalid_content_length", "Invalid request.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new HttpError(400, "invalid_content_length", "Invalid request.");
  }
  return parsed;
}

/**
 * Reads and shape-validates a JSON request body, returning `undefined` when
 * the body is empty. The top-level type is left to the caller: the REST API
 * requires an object, while JSON-RPC also permits a batch array.
 */
async function readJsonPayload(
  request: IncomingMessage,
  config: HttpSecurityConfig
): Promise<unknown> {
  const mediaType = request.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json."
    );
  }
  const declaredLength = contentLength(request);
  if (declaredLength !== undefined && declaredLength > config.bodyMaxBytes) {
    request.resume();
    throw new HttpError(413, "body_too_large", "Request body is too large.", {
      connection: "close"
    });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > config.bodyMaxBytes) {
      tooLarge = true;
      chunks.length = 0;
    } else if (!tooLarge) {
      chunks.push(buffer);
    }
  }
  if (tooLarge) {
    throw new HttpError(413, "body_too_large", "Request body is too large.", {
      connection: "close"
    });
  }
  if (chunks.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
  try {
    validateJsonShape(parsed, config);
  } catch (error) {
    if (error instanceof JsonShapeError) {
      throw new HttpError(
        400,
        "invalid_json_shape",
        "JSON body exceeds structural limits."
      );
    }
    throw error;
  }
  return parsed;
}

async function jsonBody(
  request: IncomingMessage,
  config: HttpSecurityConfig
): Promise<Record<string, unknown>> {
  const payload = await readJsonPayload(request, config);
  const parsed = payload === undefined ? {} : payload;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_json_shape", "JSON body must be an object.");
  }
  return parsed as Record<string, unknown>;
}

async function webDirectory(): Promise<string | null> {
  for (const candidate of webCandidates) {
    try {
      await access(resolve(candidate, "index.html"));
      return candidate;
    } catch {
      // Continue to the source fallback during local development.
    }
  }
  return null;
}

function toolName(pathname: string, registry: ToolRegistry): string | undefined {
  const prefix = "/api/tools/";
  if (!pathname.startsWith(prefix)) return undefined;
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return undefined;
  try {
    const decoded = decodeURIComponent(encoded);
    return Object.hasOwn(registry.tools, decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function operationGroup(
  pathname: string,
  registry: ToolRegistry
): RateLimitGroup {
  if (pathname === "/ready") return "ready";
  if (pathname === MCP_ENDPOINT) return "cheap";
  if (pathname === "/api/demo" || pathname === "/api/admin/storage") {
    return "expensive";
  }
  const name = toolName(pathname, registry);
  return name && expensiveTools.has(name) ? "expensive" : "cheap";
}

function operationTimeout(
  group: RateLimitGroup,
  config: HttpSecurityConfig
): number {
  return group === "expensive"
    ? config.expensiveOperationTimeoutMs
    : config.cheapOperationTimeoutMs;
}

async function withinTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const controller = new AbortController();
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            controller.abort();
            reject(
              new HttpError(
                504,
                "operation_timeout",
                "The operation exceeded its time limit."
              )
            );
          },
          timeoutMs
        );
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function rateLimit(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  group: RateLimitGroup,
  config: HttpSecurityConfig,
  limiter: BoundedTokenBucketRateLimiter
): boolean {
  const decision = limiter.consume(
    clientAddress(
      request,
      config.trustProxy,
      config.trustedProxyAddresses
    ),
    group
  );
  if (decision.allowed) return true;
  errorJson(
    response,
    new HttpError(429, "rate_limited", "Too many requests.", {
      "retry-after": String(decision.retryAfterSeconds),
      "ratelimit-limit": String(decision.limit),
      "ratelimit-remaining": "0"
    }),
    requestId
  );
  return false;
}

/**
 * An MCP session multiplexes handshake traffic, notifications and tool calls
 * over one path, so the path alone cannot say how costly a request is. Only a
 * `tools/call` naming an expensive tool draws from the expensive bucket; the
 * rest are ordinary protocol chatter that must not exhaust it.
 */
function mcpRateLimitGroup(
  body: unknown,
  registry: ToolRegistry
): RateLimitGroup | undefined {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as { method?: unknown; params?: unknown };
    if (record.method !== "tools/call") continue;
    const name = (record.params as { name?: unknown } | undefined)?.name;
    if (typeof name !== "string") continue;
    if (expensiveTools.has(name)) return "expensive";
    if (name in registry.tools) return "cheap";
  }
  return undefined;
}

function methodNotAllowed(allow: string): HttpError {
  return new HttpError(405, "method_not_allowed", "Method not allowed.", {
    allow
  });
}

function normalizedError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (
    error instanceof Error &&
    (error.name === "ZodError" || error.name === "ValidationError")
  ) {
    return new HttpError(400, "invalid_request", "Request validation failed.");
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (code === "57014") {
    return new HttpError(
      504,
      "database_timeout",
      "The data operation exceeded its time limit."
    );
  }
  if (
    code.startsWith("08") ||
    code.startsWith("53") ||
    ["57P01", "57P02", "57P03", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(
      code
    )
  ) {
    return new HttpError(
      503,
      "service_unavailable",
      "The data service is temporarily unavailable."
    );
  }
  if (
    error instanceof Error &&
    /^(Query read timeout|Connection terminated due to connection timeout)$/.test(
      error.message
    )
  ) {
    return new HttpError(
      504,
      "database_timeout",
      "The data operation exceeded its time limit."
    );
  }
  if (/^[0-9A-Z]{5}$/.test(code)) {
    return new HttpError(
      500,
      "database_error",
      "The data operation failed."
    );
  }
  if (error instanceof Error) {
    return new HttpError(
      422,
      "request_unprocessable",
      "The request could not be completed with the available data."
    );
  }
  return new HttpError(500, "internal_error", "An internal error occurred.");
}

function logUnexpected(error: unknown, requestId: string): void {
  if (error instanceof HttpError || (error instanceof Error && error.name === "ZodError")) {
    return;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  console.error(
    JSON.stringify({
      error: "http_request_failed",
      requestId,
      errorClass: error instanceof Error ? error.name : "UnknownError",
      ...(code ? { code } : {})
    })
  );
}

export function createHttpApp(
  registry: ToolRegistry,
  options: HttpAppOptions = {}
) {
  const config = options.security ?? loadHttpSecurityConfig();
  const limiter =
    options.rateLimiter ?? new BoundedTokenBucketRateLimiter(config);
  const mcpSessions =
    options.mcpSessions ?? new McpSessionManager(loadMcpHttpConfig());
  const server = createServer(async (request, response) => {
    const requestId = correlationId(request.headers["x-request-id"]);
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const group = operationGroup(url.pathname, registry);

      if (url.pathname === "/health") {
        if (request.method !== "GET") throw methodNotAllowed("GET");
        return json(
          response,
          200,
          { status: "ok", service: "gyeongbuk-public-ai" },
          requestId
        );
      }

      if (url.pathname === "/ready") {
        if (request.method !== "GET") throw methodNotAllowed("GET");
        if (!rateLimit(request, response, requestId, group, config, limiter)) return;
        const readiness = await withinTimeout(
          () => registry.repository.readiness(),
          operationTimeout(group, config)
        );
        return json(
          response,
          readiness.ready ? 200 : 503,
          { status: readiness.ready ? "ready" : "not_ready" },
          requestId
        );
      }

      if (url.pathname === MCP_ENDPOINT) {
        if (!rateLimit(request, response, requestId, group, config, limiter)) return;
        if (!isAuthorized(request.headers, config)) {
          throw new HttpError(401, "unauthorized", "Authentication required.", {
            "www-authenticate": '******"gyeongbuk-public-ai"'
          });
        }
        if (
          request.method !== "POST" &&
          request.method !== "GET" &&
          request.method !== "DELETE"
        ) {
          throw methodNotAllowed("POST, GET, DELETE");
        }
        // Only POST carries a JSON-RPC payload; GET opens the SSE stream and
        // DELETE terminates the session, and both must not consume a body.
        const body =
          request.method === "POST"
            ? await readJsonPayload(request, config)
            : undefined;
        const callGroup = mcpRateLimitGroup(body, registry);
        if (
          callGroup === "expensive" &&
          !rateLimit(request, response, requestId, callGroup, config, limiter)
        ) {
          return;
        }
        await handleMcpRequest(
          request,
          response,
          registry,
          mcpSessions,
          body
        );
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        if (!rateLimit(request, response, requestId, group, config, limiter)) return;
        if (!isAuthorized(request.headers, config)) {
          throw new HttpError(401, "unauthorized", "Authentication required.", {
            "www-authenticate": 'Bearer realm="gyeongbuk-public-ai"'
          });
        }

        if (url.pathname === "/api/admin/storage") {
          if (request.method !== "GET") throw methodNotAllowed("GET");
          if (config.authMode !== "token") {
            throw new HttpError(
              403,
              "admin_auth_required",
              "Administrative token authentication is required."
            );
          }
          const capacity = await withinTimeout(
            () => registry.repository.storageCapacity(),
            operationTimeout(group, config)
          );
          if (!capacity) {
            throw new HttpError(
              503,
              "storage_report_unavailable",
              "Storage capacity reporting is unavailable."
            );
          }
          return json(response, 200, capacity, requestId);
        }

        if (url.pathname === "/api/questions") {
          if (request.method !== "GET") throw methodNotAllowed("GET");
          return json(
            response,
            200,
            {
              data_status:
                registry.repository.mode === "memory" ? "demo_sample" : "mixed",
              questions: representativeQuestions
            },
            requestId
          );
        }

        if (url.pathname === "/api/demo") {
          if (request.method !== "POST") throw methodNotAllowed("POST");
          const input = await jsonBody(request, config);
          if (typeof input.questionId !== "string") {
            throw new HttpError(
              400,
              "invalid_request",
              "Request validation failed."
            );
          }
          const questionId = input.questionId;
          const result = await withinTimeout(
            (signal) =>
              runRepresentativeDemo(questionId, registry, {
                correlationId: requestId,
                signal
              }),
            operationTimeout(group, config)
          );
          return json(response, 200, result, requestId);
        }

        const name = toolName(url.pathname, registry);
        if (!name) {
          throw new HttpError(404, "not_found", "Resource not found.");
        }
        if (request.method !== "POST") throw methodNotAllowed("POST");
        const input = await jsonBody(request, config);
        const result = await withinTimeout(
          (signal) =>
            executeTool(registry, name, input, {
              correlationId: requestId,
              signal
            }),
          operationTimeout(group, config)
        );
        return json(response, 200, result, requestId);
      }

      const file = staticFiles[url.pathname];
      if (file) {
        if (request.method !== "GET") throw methodNotAllowed("GET");
        const directory = await webDirectory();
        if (!directory) {
          throw new HttpError(404, "not_found", "Resource not found.");
        }
        const type =
          extname(file) === ".css"
            ? "text/css; charset=utf-8"
            : extname(file) === ".js"
              ? "text/javascript; charset=utf-8"
              : "text/html; charset=utf-8";
        response.writeHead(
          200,
          responseHeaders(requestId, { "content-type": type })
        );
        return createReadStream(resolve(directory, file)).pipe(response);
      }

      throw new HttpError(404, "not_found", "Resource not found.");
    } catch (error) {
      const httpError = normalizedError(error);
      logUnexpected(error, requestId);
      if (!response.headersSent) {
        errorJson(response, httpError, requestId);
      } else {
        response.destroy();
      }
    }
  });
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = config.headersTimeoutMs;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(config.requestTimeoutMs);
  return server;
}
