import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BoundedTokenBucketRateLimiter,
  clientAddress,
  constantTimeTokenMatches,
  correlationId,
  loadHttpSecurityConfig,
  validateJsonShape
} from "./http-security.js";

const strongToken =
  "0123456789abcdefABCDEF-ghijklmnopqrstuvwxyz_9876543210";

describe("HTTP security utilities", () => {
  it("requires an explicit strong token in token mode", () => {
    expect(() =>
      loadHttpSecurityConfig({ HTTP_AUTH_MODE: "token" })
    ).toThrow("requires HTTP_AUTH_TOKEN");
    expect(() =>
      loadHttpSecurityConfig({
        HTTP_AUTH_MODE: "token",
        HTTP_AUTH_TOKEN: "change-me-change-me-change-me-change-me"
      })
    ).toThrow("not sufficiently strong");
    expect(
      loadHttpSecurityConfig({
        HTTP_AUTH_MODE: "token",
        HTTP_AUTH_TOKEN: strongToken
      }).authMode
    ).toBe("token");
  });

  it("compares fixed-size token digests without length-dependent buffers", () => {
    const digest = createHash("sha256").update(strongToken).digest();
    expect(constantTimeTokenMatches(strongToken, digest)).toBe(true);
    expect(constantTimeTokenMatches("short", digest)).toBe(false);
    expect(constantTimeTokenMatches(undefined, digest)).toBe(false);
  });

  it("accepts only strict inbound correlation IDs", () => {
    expect(correlationId("trace_1234-safe")).toBe("trace_1234-safe");
    expect(correlationId("bad id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-/
    );
  });

  it("ignores spoofed forwarding headers unless loopback trust is explicit", () => {
    const request = {
      headers: { "x-forwarded-for": "203.0.113.9" },
      socket: { remoteAddress: "127.0.0.1" }
    };
    expect(clientAddress(request as never, "off")).toBe("127.0.0.1");
    expect(clientAddress(request as never, "loopback")).toBe("203.0.113.9");
    expect(
      clientAddress(request as never, "explicit", new Set(["127.0.0.1"]))
    ).toBe("203.0.113.9");
  });

  it("requires validated exact IPs for explicit proxy trust", () => {
    expect(() =>
      loadHttpSecurityConfig({ HTTP_TRUST_PROXY: "explicit" })
    ).toThrow("requires HTTP_TRUST_PROXY_IPS");
    expect(
      loadHttpSecurityConfig({
        HTTP_TRUST_PROXY: "explicit",
        HTTP_TRUST_PROXY_IPS: "10.0.0.2,2001:db8::2"
      }).trustedProxyAddresses.size
    ).toBe(2);
  });

  it("bounds rate-limit memory and computes Retry-After", () => {
    const config = loadHttpSecurityConfig({
      HTTP_RATE_LIMIT_CHEAP_PER_MINUTE: "1"
    });
    config.rateLimitMaxBuckets = 3;
    const limiter = new BoundedTokenBucketRateLimiter(config);
    expect(limiter.consume("a", "cheap", 0).allowed).toBe(true);
    expect(limiter.consume("a", "cheap", 1).retryAfterSeconds).toBe(60);
    limiter.consume("b", "cheap", 2);
    limiter.consume("c", "cheap", 3);
    limiter.consume("d", "cheap", 4);
    expect(limiter.size()).toBe(3);
  });

  it("rejects excessive JSON depth and unsafe keys", () => {
    const config = loadHttpSecurityConfig({ HTTP_JSON_MAX_DEPTH: "2" });
    expect(() =>
      validateJsonShape({ one: { two: { three: true } } }, config)
    ).toThrow("depth");
    expect(() =>
      validateJsonShape(JSON.parse('{"__proto__":{"x":1}}'), config)
    ).toThrow("not allowed");
  });
});
