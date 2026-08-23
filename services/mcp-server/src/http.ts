import { readFile, readdir } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { representativeQuestions } from "./questions.js";
import { runAgent, type Planner } from "./agent.js";
import { HeuristicPlanner } from "./planner.js";
import {
  BoundedTokenBucketRateLimiter,
  JsonShapeError,
  clientAddress,
  correlationId,
  isAuthorized,
  loadHttpSecurityConfig,
  validateJsonShape,
  type HttpSecurityConfig,
  type RateLimitGroup,
  type RateLimiter
} from "./http-security.js";
import {
  handleMcpRequest,
  loadMcpHttpConfig,
  McpSessionManager
} from "./mcp-http.js";
import { executeTool, type ToolRegistry } from "./tools.js";
import {
  loadPrototypeProxyConfig,
  proxyToPrototype
} from "./prototype-proxy.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const MCP_ENDPOINT = "/mcp";

/**
 * 이 서버가 스스로 답하는 경로.
 *
 * 나머지는 전부 프로토타입 화면으로 넘어간다. 예전에는 `/api/`로 시작하면
 * 무조건 이 서버 것으로 보고 모르는 경로를 401이나 404로 돌려보냈는데,
 * 그러면 화면 쪽의 `/api/chat` 같은 경로가 여기서 막힌다. 목록을 적어 두면
 * 무엇이 서버 것이고 무엇이 화면 것인지가 코드에 남는다.
 */
const SERVER_API_PATHS = new Set([
  "/api/admin/storage",
  "/api/benchmark",
  "/api/questions",
  "/api/agent"
]);

function isServerApiPath(pathname: string, registry: ToolRegistry): boolean {
  return (
    SERVER_API_PATHS.has(pathname) || toolName(pathname, registry) !== undefined
  );
}
const expensiveTools = new Set([
  "search_council_records",
  "search_press_releases",
  "search_member_bills",
  "search_documents",
  // The pack fans out to six datasets in one call, so it is the most expensive
  // request the server accepts.
  "build_regional_evidence_pack",
  "trace_policy_response",
  "draft_evidence_backed_action",
  "compare_peer_regions",
  "get_source_context",
  "draft_public_document"
]);


const benchmarkDirectory = resolve(moduleDirectory, "../../../evals/reports");

/**
 * Serves the committed benchmark reports.
 *
 * Read from disk on each request rather than cached at boot so a run written
 * while the server is up is visible without a restart. Reports are produced by
 * `pnpm benchmark --out`, never by this endpoint: a dashboard that could
 * trigger its own measurement would let a demo produce whatever numbers it
 * needed at the moment it was asked.
 */
async function benchmarkReports(): Promise<{
  data_status: string;
  reports: unknown[];
  note: string | null;
}> {
  let names: string[];
  try {
    names = (await readdir(benchmarkDirectory)).filter((name) =>
      name.endsWith(".json")
    );
  } catch {
    return {
      data_status: "empty",
      reports: [],
      note: "벤치마크 보고서가 없습니다. pnpm benchmark -- --out evals/reports/<name>.json 으로 생성하세요."
    };
  }
  const reports: unknown[] = [];
  for (const name of names.sort()) {
    try {
      reports.push(
        JSON.parse(await readFile(resolve(benchmarkDirectory, name), "utf8"))
      );
    } catch {
      // A malformed report is skipped rather than failing the whole endpoint;
      // one bad file should not hide the runs that succeeded.
    }
  }
  return {
    data_status: reports.length > 0 ? "official_observed" : "empty",
    reports,
    note:
      reports.length > 0
        ? null
        : "벤치마크 보고서를 읽을 수 없습니다."
  };
}

export interface HttpAppOptions {
  security?: HttpSecurityConfig;
  rateLimiter?: RateLimiter;
  /**
   * Hosted MCP sessions. Callers own this so they can drain it during a
   * graceful shutdown; omitting it builds one from the environment.
   */
  mcpSessions?: McpSessionManager;
  /**
   * 화면을 서비스하는 곳. 이 서버가 답하지 않는 경로는 전부 여기로 넘어간다.
   * 생략하면 PROTOTYPE_ORIGIN에서 읽고, 그것도 없으면 프록시하지 않는다.
   */
  prototypeOrigin?: string | null;
  /**
   * Plans which datasets and tools answer a question. Defaults to the
   * deterministic planner so the server never depends on a third-party model
   * being reachable.
   */
  planner?: Planner;
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
  // The agent runs a catalog lookup, several tool calls and possibly an
  // outbound model request per invocation, so it belongs with the expensive
  // budget rather than the per-tool one.
  if (
    pathname === "/api/agent" ||
    pathname === "/api/benchmark" ||
    pathname === "/api/admin/storage"
  ) {
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

async function rateLimit(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  group: RateLimitGroup,
  config: HttpSecurityConfig,
  limiter: RateLimiter
): Promise<boolean> {
  const decision = await limiter.consume(
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
  const planner = options.planner ?? new HeuristicPlanner();
  const prototypeOrigin =
    options.prototypeOrigin !== undefined
      ? options.prototypeOrigin
      : loadPrototypeProxyConfig().origin;
  // token 모드는 데이터 경로에 토큰을 요구하려고 켜는 것이다. 그런데 화면은
  // 브라우저가 여는 것이라 헤더를 붙일 수 없어 프록시 경로는 무인증이 된다.
  // 프로토타입의 /api/chat도 그 경로로 같이 열리므로, 토큰을 요구하면서
  // 화면을 얹는 조합은 요구를 스스로 무르는 셈이다. 시작하지 않는다.
  if (prototypeOrigin && config.authMode === "token") {
    throw new Error(
      "PROTOTYPE_ORIGIN cannot be used with HTTP_AUTH_MODE=token: proxied screen " +
        "routes (including the prototype's own data APIs) would bypass the token."
    );
  }
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
        if (!(await rateLimit(request, response, requestId, group, config, limiter))) return;
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
        if (!(await rateLimit(request, response, requestId, group, config, limiter))) return;
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
          !(await rateLimit(request, response, requestId, callGroup, config, limiter))
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

      if (isServerApiPath(url.pathname, registry)) {
        if (!(await rateLimit(request, response, requestId, group, config, limiter))) return;
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

        if (url.pathname === "/api/benchmark") {
          if (request.method !== "GET") throw methodNotAllowed("GET");
          return json(response, 200, await benchmarkReports(), requestId);
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

        if (url.pathname === "/api/agent") {
          if (request.method !== "POST") throw methodNotAllowed("POST");
          const input = await jsonBody(request, config);
          if (
            typeof input.question !== "string" ||
            input.question.trim().length === 0 ||
            input.question.length > 500
          ) {
            throw new HttpError(
              400,
              "invalid_request",
              "Request validation failed."
            );
          }
          const question = input.question;
          const result = await withinTimeout(
            (signal) =>
              runAgent(registry, question, planner, {
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

      // 남은 것은 화면이다. 여기까지 왔다는 것은 이 서버가 답할 경로가
      // 아니라는 뜻이므로, 프로토타입이 있으면 그쪽으로 넘긴다.
      if (prototypeOrigin) {
        return proxyToPrototype(prototypeOrigin, request, response, (error) => {
          logUnexpected(error, requestId);
          if (response.headersSent) {
            response.destroy();
            return;
          }
          errorJson(
            response,
            new HttpError(
              502,
              "prototype_unavailable",
              `Prototype at ${prototypeOrigin} did not respond. Start it with "pnpm --filter @gb/prototype dev".`
            ),
            requestId
          );
        });
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
