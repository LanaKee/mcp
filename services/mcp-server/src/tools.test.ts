import { beforeAll, describe, expect, it } from "vitest";
import { loadDemoData, type DemoDataStore } from "./data-store.js";
import { InMemoryDataRepository } from "./repository.js";
import { createToolRegistry, executeTool, type ToolRegistry } from "./tools.js";

let store: DemoDataStore;
let registry: ToolRegistry;

beforeAll(async () => {
  store = await loadDemoData();
  registry = createToolRegistry(new InMemoryDataRepository(store));
});

describe("MCP tools", () => {
  it("returns sample status and expected population/tax comparison", async () => {
    const response = await executeTool(registry, "compare_population_and_tax", {
      startYear: 2022,
      endYear: 2024
    });
    expect(response.data_status).toBe("demo_sample");
    const result = response.result as { matches: Array<{ regionName: string }> };
    expect(result.matches.map((item) => item.regionName)).toContain("포항시");
  });

  it("strictly rejects unknown input fields", async () => {
    await expect(
      executeTool(registry, "get_population_trend", {
        region: "포항시",
        startYear: 2022,
        endYear: 2024,
        sql: "DROP TABLE population"
      })
    ).rejects.toThrow();
  });

  it("matches age-34 Sangju smart farm policies with reasons", async () => {
    const response = await executeTool(registry, "search_policies", {
      region: "상주시",
      age: 34,
      query: "스마트팜",
      stage: "예비창업"
    });
    const result = response.result as {
      matches: Array<{ eligible: boolean; reasons: string[] }>;
    };
    expect(result.matches.filter((item) => item.eligible).length).toBeGreaterThanOrEqual(2);
    expect(result.matches[0]?.reasons.length).toBeGreaterThan(2);
  });

  it("retrieves council records using Hangul substrings and date filters", async () => {
    const response = await executeTool(registry, "search_council_records", {
      query: "지방소멸",
      dateFrom: "2020-01-01",
      dateTo: "2022-12-31",
      limit: 10
    });
    const result = response.result as { matches: Array<{ id: string }> };
    expect(result.matches.map((item) => item.id)).toContain("demo-council-2020");
    expect(result.matches.every((item) => item.id !== "demo-council-2024")).toBe(true);
  });

  it("drafts only from a verified bundle", async () => {
    const response = await executeTool(registry, "draft_public_document", {
      documentType: "information_request",
      title: "자료 요청",
      verifiedAnalysis: {
        conclusion: "포항시 데모에서 인구 감소가 관측되었습니다.",
        evidence: [
          {
            statement: "2022~2024 인구 비교",
            sourceIds: ["demo-population-2026"]
          }
        ],
        sources: store.sources.filter(
          (source) => source.sourceId === "demo-population-2026"
        ),
        limitations: ["데모 샘플"],
        verified: true
      }
    });
    expect(JSON.stringify(response)).toContain("검토가 필요한 초안");
  });
});
