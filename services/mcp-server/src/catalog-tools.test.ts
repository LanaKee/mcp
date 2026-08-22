import { beforeAll, describe, expect, it } from "vitest";
import { DATASET_CATALOG } from "@gb/domain";
import { loadDemoData, type DemoDataStore } from "./data-store.js";
import { InMemoryDataRepository } from "./repository.js";
import { createToolRegistry, executeTool, type ToolRegistry } from "./tools.js";

describe("dataset catalog tools", () => {
  let store: DemoDataStore;
  let registry: ToolRegistry;

  beforeAll(async () => {
    store = await loadDemoData();
    registry = createToolRegistry(new InMemoryDataRepository(store));
  });

  const search = (input: Record<string, unknown>) =>
    executeTool(registry, "search_datasets", input);
  const describeOne = (input: Record<string, unknown>) =>
    executeTool(registry, "describe_dataset", input);

  it("routes a population question to the population dataset and its tool", async () => {
    const response = await search({ query: "인구 감소 추이" });
    const result = response.result as {
      datasets: Array<{ datasetId: string; tools: Array<{ tool: string }> }>;
    };
    expect(result.datasets[0]!.datasetId).toBe("population_observation");
    expect(result.datasets[0]!.tools.map((binding) => binding.tool)).toContain(
      "get_population_trend"
    );
  });

  it("routes a tax question to the local tax dataset", async () => {
    const response = await search({ query: "지방세 세수" });
    const result = response.result as { datasets: Array<{ datasetId: string }> };
    expect(result.datasets[0]!.datasetId).toBe("local_tax_revenue");
  });

  it("reports live coverage measured from the store rather than a static claim", async () => {
    const response = await search({ query: "인구" });
    const result = response.result as {
      datasets: Array<{
        datasetId: string;
        coverage: {
          available: boolean;
          rowCount: number;
          yearRange: { start: number; end: number } | null;
          regionCount: number;
        };
      }>;
    };
    const coverage = result.datasets.find(
      (dataset) => dataset.datasetId === "population_observation"
    )!.coverage;
    const years = store.population.map((row) => row.year);
    expect(coverage.available).toBe(true);
    expect(coverage.rowCount).toBe(store.population.length);
    expect(coverage.yearRange).toEqual({
      start: Math.min(...years),
      end: Math.max(...years)
    });
    expect(coverage.regionCount).toBe(
      new Set(store.population.map((row) => row.regionName)).size
    );
  });

  it("returns no candidates when the query shares no vocabulary with the catalog", async () => {
    // Answering an unrelated question from an arbitrary top-ranked dataset is
    // the precise failure this tool exists to prevent.
    const response = await search({ query: "zzzz 존재하지않는주제 qqqq" });
    const result = response.result as {
      datasets: unknown[];
      notes: string[];
    };
    expect(result.datasets).toHaveLength(0);
    expect(result.notes.join(" ")).toContain("겹치지 않아");
  });

  it("falls back to the corpora when the matched table is empty", async () => {
    // A subject the catalogue recognises but whose table holds nothing used to
    // end the search there, so a question about 스마트팜 창업 지원사업 returned
    // no candidates while hundreds of matching press releases sat unread.
    const empty = new InMemoryDataRepository({ ...store, policies: [] });
    const emptyRegistry = createToolRegistry(empty);
    const response = await executeTool(emptyRegistry, "search_datasets", {
      query: "스마트팜 창업 지원사업"
    });
    const result = response.result as {
      datasets: Array<{ datasetId: string }>;
      notes: string[];
    };
    const ids = result.datasets.map((dataset) => dataset.datasetId);
    expect(ids).toContain("press_release");
    expect(result.notes.join(" ")).toContain("서술 자료");
  });

  it("does not reach for the corpora when the matched table has rows", async () => {
    // Widening is a rescue, not a default. A table with rows answers for itself.
    const response = await search({ query: "인구 감소 추이" });
    const result = response.result as {
      datasets: Array<{ datasetId: string }>;
      notes: string[];
    };
    expect(result.datasets[0]!.datasetId).toBe("population_observation");
    expect(result.notes.join(" ")).not.toContain("서술 자료");
  });

  it("excludes narrative sources when observed facts are requested", async () => {
    const response = await search({
      query: "지방소멸 논의",
      evidenceRole: "observed_fact"
    });
    const result = response.result as {
      datasets: Array<{ datasetId: string; evidenceRole: string }>;
    };
    for (const dataset of result.datasets) {
      expect(dataset.evidenceRole).toBe("observed_fact");
    }
    expect(result.datasets.map((dataset) => dataset.datasetId)).not.toContain(
      "council_record"
    );
  });

  it("narrows candidates to datasets joinable with an anchor dataset", async () => {
    const response = await search({
      query: "지방세 정책 보도자료 의안",
      joinableWith: "population_observation"
    });
    const result = response.result as {
      datasets: Array<{ datasetId: string }>;
      notes: string[];
    };
    const ids = result.datasets.map((dataset) => dataset.datasetId);
    expect(ids).toContain("local_tax_revenue");
    // council_bill has no declared relationship to population.
    expect(ids).not.toContain("council_bill");
    expect(result.notes.join(" ")).toContain("조인 관계");
  });

  it("never presents a catalog lookup as evidence for an answer", async () => {
    const response = await search({ query: "인구" });
    expect(response.limitations.join(" ")).toContain("근거가 아닙니다");
  });

  it("describes measure semantics, join options and their caveats", async () => {
    const response = await describeOne({ datasetId: "local_tax_revenue" });
    const profile = response.result as {
      measures: Array<{ unit: string | null; comparabilityCaveat?: string }>;
      relationships: Array<{ datasetId: string; joinKeys: string[]; caveats: string[] }>;
      usageRules: string[];
      coverage: { available: boolean } | null;
    };
    expect(profile.measures[0]!.unit).toBe("원");
    expect(profile.measures[0]!.comparabilityCaveat).toBeTruthy();
    const toPopulation = profile.relationships.find(
      (relationship) => relationship.datasetId === "population_observation"
    )!;
    expect(toPopulation.joinKeys).toEqual(["region", "year"]);
    expect(toPopulation.caveats.length).toBeGreaterThan(0);
    expect(profile.coverage).not.toBeNull();
    // Caveats must reach the caller as limitations, not just as nested data.
    expect(response.limitations.join(" ")).toContain("amountSemantics");
  });

  it("can skip the coverage probe when only semantics are needed", async () => {
    const response = await describeOne({
      datasetId: "population_observation",
      includeCoverage: false
    });
    expect((response.result as { coverage: unknown }).coverage).toBeNull();
  });

  it("rejects an unknown dataset id instead of guessing", async () => {
    await expect(describeOne({ datasetId: "no_such_dataset" })).rejects.toThrow(
      /알 수 없는 데이터셋/u
    );
  });

  it("flags datasets that are catalogued but not loaded in this deployment", async () => {
    // The demo store has no press releases; the agent must be able to tell
    // "not deployed here" apart from "searched and found nothing".
    const response = await describeOne({ datasetId: "press_release" });
    const profile = response.result as {
      coverage: { available: boolean; note: string | null };
    };
    expect(profile.coverage.available).toBe(false);
    expect(profile.coverage.note).toContain("PostgreSQL");
  });
});

describe("catalog tool bindings match the tools' own validation", () => {
  let registry: ToolRegistry;

  beforeAll(async () => {
    registry = createToolRegistry(new InMemoryDataRepository(await loadDemoData()));
  });

  it("binds only tools the server actually registers", () => {
    for (const dataset of DATASET_CATALOG) {
      for (const binding of dataset.tools) {
        expect(
          Object.hasOwn(registry.tools, binding.tool),
          `${dataset.datasetId} -> ${binding.tool}`
        ).toBe(true);
      }
    }
  });

  it("declares enough required arguments to satisfy each tool's schema", () => {
    // The regression this locks in: search_member_bills declared no required
    // arguments while its schema refuses unless member or query is present, so
    // a planner that dutifully satisfied the catalog still produced a call the
    // tool rejected. A binding that cannot be satisfied is a broken contract
    // between the catalog and the server.
    const sampleFor = (name: string): unknown => {
      if (name.endsWith("Year")) return 2024;
      if (name === "age") return 34;
      if (name === "limit") return 5;
      if (name === "sourceIds") return ["official:sample"];
      return "샘플";
    };

    for (const dataset of DATASET_CATALOG) {
      for (const binding of dataset.tools) {
        const tool = registry.tools[binding.tool];
        if (!tool) continue;
        const input = Object.fromEntries(
          binding.requiredArguments.map((name) => [name, sampleFor(name)])
        );
        expect(
          () => tool.parse(input),
          `${dataset.datasetId} -> ${binding.tool} (${JSON.stringify(input)})`
        ).not.toThrow();
      }
    }
  });
});
