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

  it("runs a representative question without demo fallback data", async () => {
    const response = await fetch(`${baseUrl}/api/demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: "population-tax" })
    });
    const value = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(value).toHaveProperty("conclusion");
    expect(value.data_status).toBe("empty");
    expect(value.conclusion).toContain("결론을 생성하지 않았습니다");
    expect(JSON.stringify(value)).not.toContain("지방세 +");
  });
});
