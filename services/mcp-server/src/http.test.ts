import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { loadDemoData } from "./data-store.js";
import { createHttpApp } from "./http.js";
import { InMemoryDataRepository } from "./repository.js";
import { createToolRegistry } from "./tools.js";

let baseUrl = "";
let server: ReturnType<typeof createHttpApp>;

beforeAll(async () => {
  const store = await loadDemoData();
  server = createHttpApp(createToolRegistry(new InMemoryDataRepository(store)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

describe("HTTP API", () => {
  it("reports health", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok"
    });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'self'"
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("reports repository readiness separately", async () => {
    const response = await fetch(`${baseUrl}/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ready"
    });
  });

  it("lists representative questions as questions only", async () => {
    const response = await fetch(`${baseUrl}/api/questions`);
    const value = (await response.json()) as {
      questions: Array<Record<string, unknown>>;
    };
    expect(response.status).toBe(200);
    expect(value.questions.length).toBeGreaterThan(0);
    // The demo must not ship pre-bound tools or answers: the agent has to
    // resolve every question at request time, like a typed one.
    for (const question of value.questions) {
      expect(Object.keys(question).sort()).toEqual(["id", "question"]);
    }
  });

  it("answers an agent question with a route that can be audited", async () => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "포항시 인구 추세를 알려줘" })
    });
    const value = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(value).toHaveProperty("planner");
    expect(value).toHaveProperty("consideredDatasets");
    expect(value).toHaveProperty("plan");
    expect(value).toHaveProperty("conclusion");
    expect(value).toHaveProperty("sources");
  });

  it("rejects an agent request with no question", async () => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "   " })
    });
    expect(response.status).toBe(400);
  });

  it("rejects an agent question that exceeds the length limit", async () => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "가".repeat(501) })
    });
    expect(response.status).toBe(400);
  });
});

describe("benchmark dashboard endpoint", () => {
  it("serves the committed reports and never measures on request", async () => {
    const response = await fetch(`${baseUrl}/api/benchmark`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data_status: string;
      reports: Array<{ planner: string; checkRates: Record<string, unknown> }>;
      note: string | null;
    };
    if (payload.reports.length === 0) {
      expect(payload.data_status).toBe("empty");
      expect(payload.note).toContain("pnpm benchmark");
      return;
    }
    for (const report of payload.reports) {
      expect(report.planner.length).toBeGreaterThan(0);
      expect(Object.keys(report.checkRates).length).toBeGreaterThan(0);
    }
  });

  it("rejects a write to the dashboard endpoint", async () => {
    const response = await fetch(`${baseUrl}/api/benchmark`, { method: "POST" });
    expect(response.status).toBe(405);
  });
});
