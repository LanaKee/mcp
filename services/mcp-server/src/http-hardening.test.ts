import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { loadDemoData } from "./data-store.js";
import { createHttpApp } from "./http.js";
import { loadHttpSecurityConfig } from "./http-security.js";
import {
  InMemoryDataRepository,
  type AuditEvent,
  type FactDataStatus,
  type StorageCapacitySummary
} from "./repository.js";
import { createToolRegistry } from "./tools.js";

const token =
  "0123456789abcdefABCDEF-ghijklmnopqrstuvwxyz_9876543210";

class AuditedRepository extends InMemoryDataRepository {
  readonly audits: AuditEvent[] = [];

  override async writeAudit(event: AuditEvent): Promise<void> {
    this.audits.push(event);
  }

  override async storageCapacity(): Promise<StorageCapacitySummary> {
    return {
      generatedAt: "2026-08-22T00:00:00.000Z",
      counts: {
        currentChunks: 23_795,
        staleChunks: 17_487,
        currentEmbeddings: 23_795,
        staleEmbeddings: 17_487,
        currentPages: 11_712,
        stalePages: 0,
        expiredAuditRows: 0
      },
      sizes: {
        databaseBytes: 1_500_000_000,
        documentChunkBytes: 1_000_000_000,
        documentChunkIndexBytes: 200_000_000,
        embeddingBytes: 360_000_000,
        embeddingIndexBytes: 20_000_000,
        documentPageBytes: 44_000_000,
        documentPageIndexBytes: 10_000_000
      },
      versions: [
        {
          versionKey: "extractor::chunker",
          approvalState: "approved",
          chunks: 23_795,
          currentChunks: 23_795,
          embeddings: 23_795,
          documents: 401
        }
      ],
      settings: {
        serverVersion: "16",
        maintenanceWorkMem: "64MB"
      },
      warnings: ["stale_chunk_ratio:42.4%>=25%"]
    };
  }
}

class FailingRepository extends AuditedRepository {
  override async getPopulationTrend(_input: {
    region?: string;
    startYear: number;
    endYear: number;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<never> {
    throw new Error("DATABASE_URL=must-not-leak");
  }
}

class SlowRepository extends AuditedRepository {
  override async getPopulationTrend(input: {
    region?: string;
    startYear: number;
    endYear: number;
    dataStatuses: readonly FactDataStatus[];
  }) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    return super.getPopulationTrend(input);
  }
}

async function withServer(
  env: NodeJS.ProcessEnv,
  run: (baseUrl: string, repository: AuditedRepository) => Promise<void>,
  repositoryKind: "normal" | "failing" | "slow" = "normal"
): Promise<void> {
  const store = await loadDemoData();
  const repository =
    repositoryKind === "failing"
      ? new FailingRepository(store)
      : repositoryKind === "slow"
        ? new SlowRepository(store)
        : new AuditedRepository(store);
  const server = createHttpApp(createToolRegistry(repository), {
    security: loadHttpSecurityConfig(env)
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`, repository);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...extra
  };
}

describe("HTTP production hardening", () => {
  it("protects APIs while keeping public status minimal", async () => {
    await withServer(
      { HTTP_AUTH_MODE: "token", HTTP_AUTH_TOKEN: token },
      async (baseUrl) => {
        const health = await fetch(`${baseUrl}/health`);
        expect(health.status).toBe(200);
        expect(await health.json()).toEqual({
          status: "ok",
          service: "gyeongbuk-public-ai"
        });

        const ready = await fetch(`${baseUrl}/ready`);
        expect(await ready.json()).toEqual({ status: "ready" });

        const unauthorized = await fetch(`${baseUrl}/api/questions`);
        expect(unauthorized.status).toBe(401);
        expect(unauthorized.headers.get("www-authenticate")).toContain("Bearer");
        expect(JSON.stringify(await unauthorized.json())).not.toContain(token);

        const authorized = await fetch(`${baseUrl}/api/questions`, {
          headers: authHeaders()
        });
        expect(authorized.status).toBe(200);

        const apiKey = await fetch(`${baseUrl}/api/questions`, {
          headers: { "x-api-key": token }
        });
        expect(apiKey.status).toBe(200);
      }
    );
  });

  it("exposes capacity details only behind configured admin token auth", async () => {
    await withServer(
      { HTTP_AUTH_MODE: "token", HTTP_AUTH_TOKEN: token },
      async (baseUrl) => {
        const unauthorized = await fetch(`${baseUrl}/api/admin/storage`);
        expect(unauthorized.status).toBe(401);

        const authorized = await fetch(`${baseUrl}/api/admin/storage`, {
          headers: authHeaders()
        });
        expect(authorized.status).toBe(200);
        expect(await authorized.json()).toMatchObject({
          counts: { currentChunks: 23_795, staleChunks: 17_487 },
          settings: { maintenanceWorkMem: "64MB" }
        });
      }
    );
    await withServer({ HTTP_AUTH_MODE: "off" }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/admin/storage`);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "admin_auth_required" }
      });
    });
  });

  it("propagates safe correlation IDs into responses and audits", async () => {
    await withServer(
      { HTTP_AUTH_MODE: "token", HTTP_AUTH_TOKEN: token },
      async (baseUrl, repository) => {
        const requestId = "trace_1234-safe";
        const response = await fetch(
          `${baseUrl}/api/tools/get_population_trend`,
          {
            method: "POST",
            headers: authHeaders({
              "content-type": "application/json",
              "x-request-id": requestId
            }),
            body: JSON.stringify({
              region: "포항시",
              startYear: 2024,
              endYear: 2024,
              dataStatuses: ["demo_sample"]
            })
          }
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("x-request-id")).toBe(requestId);
        expect(repository.audits.at(-1)?.correlationId).toBe(requestId);

        const invalidId = await fetch(`${baseUrl}/api/questions`, {
          headers: authHeaders({ "x-request-id": "bad id" })
        });
        expect(invalidId.headers.get("x-request-id")).not.toBe("bad id");
      }
    );
  });

  it("uses tighter expensive-route rate limits with Retry-After", async () => {
    await withServer(
      {
        HTTP_AUTH_MODE: "token",
        HTTP_AUTH_TOKEN: token,
        HTTP_RATE_LIMIT_CHEAP_PER_MINUTE: "20",
        HTTP_RATE_LIMIT_EXPENSIVE_PER_MINUTE: "1"
      },
      async (baseUrl) => {
        const request = () =>
          fetch(`${baseUrl}/api/tools/search_council_records`, {
            method: "POST",
            headers: authHeaders({ "content-type": "application/json" }),
            body: JSON.stringify({ query: "지방소멸", limit: 2 })
          });
        expect((await request()).status).toBe(200);
        const limited = await request();
        expect(limited.status).toBe(429);
        expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(await limited.json()).toMatchObject({
          error: { code: "rate_limited" }
        });
      }
    );
  });

  it("enforces content type, body, shape, route, and method allowlists", async () => {
    await withServer(
      {
        HTTP_AUTH_MODE: "token",
        HTTP_AUTH_TOKEN: token,
        HTTP_BODY_MAX_BYTES: "1024",
        HTTP_JSON_MAX_DEPTH: "2"
      },
      async (baseUrl) => {
        const noContentType = await fetch(
          `${baseUrl}/api/tools/get_population_trend`,
          {
            method: "POST",
            headers: authHeaders(),
            body: "{}"
          }
        );
        expect(noContentType.status).toBe(415);

        const oversized = await fetch(
          `${baseUrl}/api/tools/get_population_trend`,
          {
            method: "POST",
            headers: authHeaders({ "content-type": "application/json" }),
            body: JSON.stringify({ padding: "x".repeat(1_100) })
          }
        );
        expect(oversized.status).toBe(413);

        const deep = await fetch(`${baseUrl}/api/tools/get_population_trend`, {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ nested: { too: { deep: true } } })
        });
        expect(deep.status).toBe(400);
        expect(await deep.json()).toMatchObject({
          error: { code: "invalid_json_shape" }
        });

        const unknown = await fetch(`${baseUrl}/api/tools/not-a-tool`, {
          method: "POST",
          headers: authHeaders({ "content-type": "text/plain" }),
          body: "not-json"
        });
        expect(unknown.status).toBe(404);

        const wrongMethod = await fetch(`${baseUrl}/api/questions`, {
          method: "POST",
          headers: authHeaders()
        });
        expect(wrongMethod.status).toBe(405);
        expect(wrongMethod.headers.get("allow")).toBe("GET");
      }
    );
  });

  it("returns non-sensitive correlated errors for backend failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await withServer(
      { HTTP_AUTH_MODE: "token", HTTP_AUTH_TOKEN: token },
      async (baseUrl) => {
        const response = await fetch(
          `${baseUrl}/api/tools/get_population_trend`,
          {
            method: "POST",
            headers: authHeaders({
              "content-type": "application/json",
              "x-request-id": "failure_1234"
            }),
            body: JSON.stringify({
              region: "포항시",
              startYear: 2024,
              endYear: 2024
            })
          }
        );
        const text = await response.text();
        expect(response.status).toBe(422);
        expect(text).toContain("failure_1234");
        expect(text).not.toContain("DATABASE_URL");
        expect(text).not.toContain("must-not-leak");
      },
      "failing"
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"requestId":"failure_1234"')
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("must-not-leak");
    errorSpy.mockRestore();
  });

  it("bounds slow operations and marks their audit as aborted", async () => {
    await withServer(
      {
        HTTP_AUTH_MODE: "token",
        HTTP_AUTH_TOKEN: token,
        HTTP_REQUEST_TIMEOUT_MS: "1000",
        HTTP_CHEAP_OPERATION_TIMEOUT_MS: "500"
      },
      async (baseUrl, repository) => {
        const response = await fetch(
          `${baseUrl}/api/tools/get_population_trend`,
          {
            method: "POST",
            headers: authHeaders({
              "content-type": "application/json",
              "x-request-id": "timeout_1234"
            }),
            body: JSON.stringify({
              region: "포항시",
              startYear: 2024,
              endYear: 2024
            })
          }
        );
        expect(response.status).toBe(504);
        expect(await response.json()).toMatchObject({
          error: { code: "operation_timeout" },
          request_id: "timeout_1234"
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(repository.audits.at(-1)).toMatchObject({
          correlationId: "timeout_1234",
          success: false,
          errorClass: "AbortError"
        });
      },
      "slow"
    );
  });
});
