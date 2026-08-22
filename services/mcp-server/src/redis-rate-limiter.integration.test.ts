import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "redis";
import {
  RedisTokenBucketRateLimiter,
  type HttpSecurityConfig
} from "./http-security.js";

// Self-skips like the *.integration.test.ts suites that need real
// PostgreSQL: only runs when a real Redis is reachable at TEST_REDIS_URL.
const redisUrl = process.env.TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

function config(overrides: Partial<HttpSecurityConfig["rateLimits"]> = {}) {
  return {
    rateLimits: { cheap: 3, expensive: 1, ready: 1, ...overrides },
    rateLimitIdleMs: 600_000
  } as unknown as HttpSecurityConfig;
}

describeRedis("RedisTokenBucketRateLimiter integration", () => {
  const clients: Array<ReturnType<typeof createClient>> = [];

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.quit().catch(() => undefined)));
  });

  async function connectedClient() {
    const client = createClient({ url: redisUrl });
    await client.connect();
    clients.push(client);
    return client;
  }

  it("shares bucket state across independent client connections", async () => {
    // Two clients stand in for two mcp-server instances behind a load
    // balancer, both talking to the same Redis.
    const clientA = await connectedClient();
    const clientB = await connectedClient();
    const key = `test:${crypto.randomUUID()}`;
    const limiterA = new RedisTokenBucketRateLimiter(clientA, config(), key);
    const limiterB = new RedisTokenBucketRateLimiter(clientB, config(), key);

    const now = 10_000;
    const first = await limiterA.consume("client1", "cheap", now);
    const second = await limiterB.consume("client1", "cheap", now);
    const third = await limiterA.consume("client1", "cheap", now);
    const fourth = await limiterB.consume("client1", "cheap", now);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(true);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("refills tokens over time and isolates distinct clients/groups", async () => {
    const client = await connectedClient();
    const key = `test:${crypto.randomUUID()}`;
    const limiter = new RedisTokenBucketRateLimiter(client, config(), key);

    const now = 10_000;
    await limiter.consume("client1", "cheap", now);
    await limiter.consume("client1", "cheap", now);
    await limiter.consume("client1", "cheap", now);
    const denied = await limiter.consume("client1", "cheap", now);
    expect(denied.allowed).toBe(false);

    // A different client key must not be affected by client1's exhaustion.
    const otherClient = await limiter.consume("client2", "cheap", now);
    expect(otherClient.allowed).toBe(true);

    // A different rate-limit group for the same client must not be affected.
    const otherGroup = await limiter.consume("client1", "expensive", now);
    expect(otherGroup.allowed).toBe(true);

    // After a full refill window (60s for a 3/min bucket), requests succeed again.
    const refilled = await limiter.consume("client1", "cheap", now + 61_000);
    expect(refilled.allowed).toBe(true);
  });
});
