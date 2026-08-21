import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

export type HttpAuthMode = "off" | "token";
export type TrustedProxyMode = "off" | "loopback" | "explicit";
export type RateLimitGroup = "cheap" | "expensive" | "ready";

export interface HttpSecurityConfig {
  authMode: HttpAuthMode;
  authTokenDigest: Buffer | null;
  trustProxy: TrustedProxyMode;
  trustedProxyAddresses: ReadonlySet<string>;
  bodyMaxBytes: number;
  jsonMaxDepth: number;
  jsonMaxNodes: number;
  jsonMaxArrayItems: number;
  rateLimits: Record<RateLimitGroup, number>;
  rateLimitMaxBuckets: number;
  rateLimitIdleMs: number;
  cheapOperationTimeoutMs: number;
  expensiveOperationTimeoutMs: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

interface TokenBucket {
  tokens: number;
  updatedAt: number;
  lastSeenAt: number;
}

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;

function envInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function validateStrongHttpToken(value: string | undefined): string {
  if (!value) {
    throw new Error("HTTP_AUTH_MODE=token requires HTTP_AUTH_TOKEN");
  }
  if (value !== value.trim() || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(
      "HTTP_AUTH_TOKEN must be at least 32 bytes with no surrounding whitespace"
    );
  }
  if (Buffer.byteLength(value, "utf8") > 1024) {
    throw new Error("HTTP_AUTH_TOKEN must not exceed 1024 bytes");
  }
  const normalized = value.toLowerCase();
  if (
    /(change.?me|replace|example|default|password|secret)/i.test(normalized) ||
    new Set(value).size < 10
  ) {
    throw new Error("HTTP_AUTH_TOKEN is not sufficiently strong");
  }
  return value;
}

export function loadHttpSecurityConfig(
  env: NodeJS.ProcessEnv = process.env
): HttpSecurityConfig {
  const authMode = (env.HTTP_AUTH_MODE ?? "off").toLowerCase();
  if (authMode !== "off" && authMode !== "token") {
    throw new Error("HTTP_AUTH_MODE must be off or token");
  }
  const trustProxy = (env.HTTP_TRUST_PROXY ?? "off").toLowerCase();
  if (
    trustProxy !== "off" &&
    trustProxy !== "loopback" &&
    trustProxy !== "explicit"
  ) {
    throw new Error("HTTP_TRUST_PROXY must be off, loopback, or explicit");
  }
  const trustedProxyAddresses = new Set(
    (env.HTTP_TRUST_PROXY_IPS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  if (
    trustedProxyAddresses.size > 32 ||
    [...trustedProxyAddresses].some((value) => isIP(value) === 0)
  ) {
    throw new Error(
      "HTTP_TRUST_PROXY_IPS must contain at most 32 comma-separated IP addresses"
    );
  }
  if (trustProxy === "explicit" && trustedProxyAddresses.size === 0) {
    throw new Error(
      "HTTP_TRUST_PROXY=explicit requires HTTP_TRUST_PROXY_IPS"
    );
  }
  const authToken =
    authMode === "token" ? validateStrongHttpToken(env.HTTP_AUTH_TOKEN) : null;
  const requestTimeoutMs = envInteger(
    env,
    "HTTP_REQUEST_TIMEOUT_MS",
    15_000,
    1_000,
    120_000
  );
  const headersTimeoutMs = envInteger(
    env,
    "HTTP_HEADERS_TIMEOUT_MS",
    Math.min(10_000, requestTimeoutMs),
    1_000,
    requestTimeoutMs
  );
  return {
    authMode,
    authTokenDigest: authToken ? tokenDigest(authToken) : null,
    trustProxy,
    trustedProxyAddresses,
    bodyMaxBytes: envInteger(
      env,
      "HTTP_BODY_MAX_BYTES",
      65_536,
      1_024,
      1_048_576
    ),
    jsonMaxDepth: envInteger(env, "HTTP_JSON_MAX_DEPTH", 12, 2, 32),
    jsonMaxNodes: envInteger(env, "HTTP_JSON_MAX_NODES", 5_000, 100, 50_000),
    jsonMaxArrayItems: envInteger(
      env,
      "HTTP_JSON_MAX_ARRAY_ITEMS",
      1_000,
      10,
      10_000
    ),
    rateLimits: {
      cheap: envInteger(env, "HTTP_RATE_LIMIT_CHEAP_PER_MINUTE", 120, 1, 10_000),
      expensive: envInteger(
        env,
        "HTTP_RATE_LIMIT_EXPENSIVE_PER_MINUTE",
        12,
        1,
        1_000
      ),
      ready: envInteger(env, "HTTP_RATE_LIMIT_READY_PER_MINUTE", 60, 1, 1_000)
    },
    rateLimitMaxBuckets: envInteger(
      env,
      "HTTP_RATE_LIMIT_MAX_BUCKETS",
      10_000,
      100,
      100_000
    ),
    rateLimitIdleMs: envInteger(
      env,
      "HTTP_RATE_LIMIT_IDLE_MS",
      600_000,
      60_000,
      3_600_000
    ),
    cheapOperationTimeoutMs: envInteger(
      env,
      "HTTP_CHEAP_OPERATION_TIMEOUT_MS",
      Math.min(8_000, requestTimeoutMs),
      500,
      requestTimeoutMs
    ),
    expensiveOperationTimeoutMs: envInteger(
      env,
      "HTTP_EXPENSIVE_OPERATION_TIMEOUT_MS",
      Math.min(12_000, requestTimeoutMs),
      1_000,
      requestTimeoutMs
    ),
    requestTimeoutMs,
    headersTimeoutMs
  };
}

function headerValue(
  headers: IncomingHttpHeaders,
  name: string
): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

export function requestToken(headers: IncomingHttpHeaders): string | undefined {
  const authorization = headerValue(headers, "authorization");
  const bearer = authorization?.match(/^Bearer ([^\s]{1,1024})$/i)?.[1];
  const apiKey = headerValue(headers, "x-api-key");
  if (apiKey && (apiKey !== apiKey.trim() || apiKey.length > 1024)) {
    return undefined;
  }
  if (bearer && apiKey && bearer !== apiKey) return undefined;
  return bearer ?? apiKey;
}

export function constantTimeTokenMatches(
  candidate: string | undefined,
  expectedDigest: Buffer
): boolean {
  const candidateDigest = tokenDigest(candidate ?? "");
  const equal = timingSafeEqual(candidateDigest, expectedDigest);
  return candidate !== undefined && equal;
}

export function isAuthorized(
  headers: IncomingHttpHeaders,
  config: HttpSecurityConfig
): boolean {
  if (config.authMode === "off") return true;
  return constantTimeTokenMatches(
    requestToken(headers),
    config.authTokenDigest!
  );
}

export function correlationId(value: string | string[] | undefined): string {
  return typeof value === "string" && requestIdPattern.test(value)
    ? value
    : randomUUID();
}

function isLoopback(value: string): boolean {
  return (
    value === "127.0.0.1" ||
    value === "::1" ||
    value.startsWith("127.") ||
    value.startsWith("::ffff:127.")
  );
}

function normalizedAddress(value: string): string {
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  return mapped && isIP(mapped) === 4 ? mapped : value;
}

export function clientAddress(
  request: Pick<IncomingMessage, "headers" | "socket">,
  trustProxy: TrustedProxyMode,
  trustedProxyAddresses: ReadonlySet<string> = new Set()
): string {
  const remote = request.socket.remoteAddress ?? "unknown";
  const normalizedRemote = normalizedAddress(remote);
  const trusted =
    (trustProxy === "loopback" && isLoopback(remote)) ||
    (trustProxy === "explicit" &&
      (trustedProxyAddresses.has(remote) ||
        trustedProxyAddresses.has(normalizedRemote)));
  if (trusted) {
    const forwarded = headerValue(request.headers, "x-forwarded-for")
      ?.split(",", 1)[0]
      ?.trim();
    if (forwarded && forwarded.length <= 64 && isIP(forwarded) !== 0) {
      return forwarded;
    }
  }
  return normalizedRemote;
}

export class BoundedTokenBucketRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private operations = 0;

  constructor(private readonly config: HttpSecurityConfig) {}

  consume(
    clientKey: string,
    group: RateLimitGroup,
    now = Date.now()
  ): RateLimitDecision {
    this.operations += 1;
    if (this.operations % 100 === 0) this.prune(now);
    const key = `${group}:${clientKey}`;
    const limit = this.config.rateLimits[group];
    const refillPerMs = limit / 60_000;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.config.rateLimitMaxBuckets) {
        this.evictOldest();
      }
      bucket = { tokens: limit, updatedAt: now, lastSeenAt: now };
      this.buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(
      limit,
      bucket.tokens + Math.max(0, now - bucket.updatedAt) * refillPerMs
    );
    bucket.updatedAt = now;
    bucket.lastSeenAt = now;
    if (bucket.tokens < 1) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((1 - bucket.tokens) / refillPerMs / 1_000)
        )
      };
    }
    bucket.tokens -= 1;
    return {
      allowed: true,
      limit,
      remaining: Math.floor(bucket.tokens),
      retryAfterSeconds: 0
    };
  }

  size(): number {
    return this.buckets.size;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastSeenAt > this.config.rateLimitIdleMs) {
        this.buckets.delete(key);
      }
    }
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastSeenAt < oldestTime) {
        oldestKey = key;
        oldestTime = bucket.lastSeenAt;
      }
    }
    if (oldestKey) this.buckets.delete(oldestKey);
  }
}

export class JsonShapeError extends Error {}

export function validateJsonShape(
  value: unknown,
  config: Pick<
    HttpSecurityConfig,
    "jsonMaxDepth" | "jsonMaxNodes" | "jsonMaxArrayItems"
  >
): void {
  const queue: Array<{ value: unknown; depth: number }> = [
    { value, depth: 1 }
  ];
  let nodes = 0;
  while (queue.length > 0) {
    const current = queue.pop()!;
    nodes += 1;
    if (nodes > config.jsonMaxNodes) {
      throw new JsonShapeError("JSON node limit exceeded");
    }
    if (current.depth > config.jsonMaxDepth) {
      throw new JsonShapeError("JSON depth limit exceeded");
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > config.jsonMaxArrayItems) {
        throw new JsonShapeError("JSON array limit exceeded");
      }
      for (const item of current.value) {
        queue.push({ value: item, depth: current.depth + 1 });
      }
    } else if (current.value && typeof current.value === "object") {
      const entries = Object.entries(current.value as Record<string, unknown>);
      if (entries.length > 100) {
        throw new JsonShapeError("JSON object key limit exceeded");
      }
      for (const [key, item] of entries) {
        if (
          key.length > 100 ||
          key === "__proto__" ||
          key === "prototype" ||
          key === "constructor"
        ) {
          throw new JsonShapeError("JSON object key is not allowed");
        }
        queue.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
}
