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
  it("returns demo context without a population/tax verdict", async () => {
    const response = await executeTool(registry, "compare_population_and_tax", {
      startYear: 2022,
      endYear: 2024,
      dataStatuses: ["demo_sample"]
    });
    expect(response.data_status).toBe("demo_sample");
    const result = response.result as {
      matches: Array<{ regionName: string }>;
      not_evaluable: Array<{
        regionName: string;
        notEvaluableReason: string;
        matches: null;
      }>;
    };
    expect(result.matches).toHaveLength(0);
    expect(result.not_evaluable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          regionName: "포항시",
          notEvaluableReason: "non_official_data",
          matches: null
        })
      ])
    );
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
      stage: "예비창업",
      dataStatuses: ["demo_sample"]
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
      limit: 10,
      dataStatuses: ["demo_sample"]
    });
    const result = response.result as { matches: Array<{ id: string }> };
    expect(result.matches.map((item) => item.id)).toContain("demo-council-2020");
    expect(result.matches.every((item) => item.id !== "demo-council-2024")).toBe(true);
  });

  it("labels press release results as narrative context, never as measurements", async () => {
    const response = await executeTool(registry, "search_press_releases", {
      query: "청년 창업",
      limit: 5
    });
    const result = response.result as { evidence_role: string };
    expect(result.evidence_role).toBe("narrative_context_only");
    expect(
      response.limitations.some((line) =>
        line.includes("verify_claim_with_data")
      )
    ).toBe(true);
  });

  it("does not accept a dataStatuses override on press release search", async () => {
    // Press releases are always official announcements, so offering a status
    // filter would imply a demo variant exists and could be mixed in.
    await expect(
      executeTool(registry, "search_press_releases", {
        query: "청년",
        dataStatuses: ["demo_sample"]
      })
    ).rejects.toThrow();
  });

  it("refuses a member bill search with neither a member nor a query", async () => {
    // An unfiltered call would dump the council's whole legislative record and
    // read as if it answered the caller's question.
    await expect(executeTool(registry, "search_member_bills", {})).rejects.toThrow();
  });

  it("never claims a member bill search settles pledge fulfilment", async () => {
    const response = await executeTool(registry, "search_member_bills", {
      member: "김대진",
      limit: 5
    });
    const result = response.result as { evidence_role: string };
    expect(result.evidence_role).toBe("narrative_context_only");
    expect(response.limitations.some((line) => line.includes("공약"))).toBe(true);
    expect(
      response.limitations.some((line) => line.includes("공동발의"))
    ).toBe(true);
  });

  it("rejects demo evidence for a public document", async () => {
    await expect(
      executeTool(registry, "draft_public_document", {
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
      })
    ).rejects.toThrow("demo_sample");
  });
});
