import { beforeAll, describe, expect, it } from "vitest";
import { loadDemoData } from "./data-store.js";
import { InMemoryDataRepository } from "./repository.js";
import { createToolRegistry, type ToolRegistry } from "./tools.js";
import { runAgent, validateStep, type AgentPlan, type Planner } from "./agent.js";
import { extractEntities, HeuristicPlanner } from "./planner.js";
import { searchDatasets, type DatasetSearchHit } from "./catalog-tools.js";

/** Planner that returns a fixed plan, used to probe the validation boundary. */
function fixedPlanner(plan: AgentPlan, name = "fixed"): Planner {
  return { name, plan: async () => plan };
}

describe("entity extraction", () => {
  it("finds a region named with or without its administrative suffix", () => {
    expect(extractEntities("상주에서 창업하려면").region).toBe("상주시");
    expect(extractEntities("포항시 인구는?").region).toBe("포항시");
  });

  it("returns no region when none is named rather than guessing one", () => {
    expect(extractEntities("인구가 줄고 있나?").region).toBeNull();
  });

  it("reads a year range and a single year", () => {
    expect(extractEntities("2020년부터 2024년까지")).toMatchObject({
      startYear: 2020,
      endYear: 2024
    });
    const single = extractEntities("2024년 인구");
    expect(single.startYear).toBe(2024);
    expect(single.endYear).toBe(2024);
  });

  it("reads an age only from an age expression", () => {
    expect(extractEntities("34세 예비창업자").age).toBe(34);
    expect(extractEntities("2024년 인구 34만명").age).toBeNull();
  });
});

describe("agent plan validation", () => {
  let registry: ToolRegistry;
  let candidates: DatasetSearchHit[];

  beforeAll(async () => {
    registry = createToolRegistry(
      new InMemoryDataRepository(await loadDemoData())
    );
    candidates = (
      await searchDatasets(registry.repository, { query: "인구", limit: 5 })
    ).hits;
  });

  const step = (overrides: Record<string, unknown> = {}) => ({
    datasetId: "population_observation",
    tool: "get_population_trend",
    arguments: { region: "포항시", startYear: 2020, endYear: 2024 },
    reason: "테스트",
    ...overrides
  });

  it("accepts a step the catalog sanctions", () => {
    expect(validateStep(step(), candidates, registry)).toBeNull();
  });

  it("rejects a tool that does not exist on this server", () => {
    expect(
      validateStep(step({ tool: "get_unicorn_statistics" }), candidates, registry)
    ).toContain("연결된 도구가 아닙니다");
  });

  it("rejects a real tool attached to the wrong dataset", () => {
    // An LLM may pair a plausible tool with the wrong dataset; the binding
    // declared in the catalog is what decides, not the tool's existence.
    expect(
      validateStep(
        step({ tool: "get_local_tax_revenue_trend" }),
        candidates,
        registry
      )
    ).toContain("연결된 도구가 아닙니다");
  });

  it("rejects a dataset that was never a candidate for this question", () => {
    expect(
      validateStep(
        step({ datasetId: "press_release", tool: "search_press_releases" }),
        candidates,
        registry
      )
    ).toContain("후보 데이터셋이 아닙니다");
  });

  it("rejects a step missing a required argument", () => {
    expect(
      validateStep(
        step({ arguments: { startYear: 2020, endYear: 2024 } }),
        candidates,
        registry
      )
    ).toContain("region");
  });
});

describe("agent execution", () => {
  let registry: ToolRegistry;

  beforeAll(async () => {
    registry = createToolRegistry(
      new InMemoryDataRepository(await loadDemoData())
    );
  });

  it("routes a population question to the population tool and cites sources", async () => {
    const answer = await runAgent(
      registry,
      "포항시 인구는 2020년부터 2024년까지 어떻게 변했나?",
      new HeuristicPlanner()
    );
    expect(answer.answered).toBe(true);
    expect(answer.plan[0]!.tool).toBe("get_population_trend");
    expect(answer.evidence[0]!.sourceIds.length).toBeGreaterThan(0);
    // Every cited id must resolve to a source object in the same answer.
    const known = new Set(answer.sources.map((source) => source.sourceId));
    for (const item of answer.evidence) {
      for (const sourceId of item.sourceIds) expect(known.has(sourceId)).toBe(true);
    }
  });

  it("refuses instead of guessing when no region is named", async () => {
    const answer = await runAgent(
      registry,
      "인구는 어떻게 변했나?",
      new HeuristicPlanner()
    );
    expect(answer.answered).toBe(false);
    expect(answer.conclusion).toContain("시군");
  });

  it("says so when the catalog has nothing for the question", async () => {
    const answer = await runAgent(
      registry,
      "zzzz 존재하지않는주제 qqqq",
      new HeuristicPlanner()
    );
    expect(answer.answered).toBe(false);
    expect(answer.consideredDatasets).toHaveLength(0);
  });

  it("never executes a hallucinated tool, and reports the refusal", async () => {
    const answer = await runAgent(
      registry,
      "포항시 인구 2020년부터 2024년",
      fixedPlanner({
        steps: [
          {
            datasetId: "population_observation",
            tool: "delete_everything",
            arguments: {},
            reason: "환각된 도구"
          }
        ],
        unanswerable: null
      })
    );
    expect(answer.answered).toBe(false);
    expect(answer.evidence).toHaveLength(0);
    expect(answer.rejectedSteps).toHaveLength(1);
    expect(answer.rejectedSteps[0]!.reason).toContain("도구가 아닙니다");
  });

  it("attaches the declared join and its caveats when two datasets are combined", async () => {
    const answer = await runAgent(
      registry,
      "포항시 2020년부터 2024년까지 인구와 지방세 세수 변화",
      new HeuristicPlanner()
    );
    const datasets = answer.evidence.map((item) => item.datasetId);
    expect(datasets).toContain("population_observation");
    expect(datasets).toContain("local_tax_revenue");
    // Direction follows execution order, which follows catalog ranking, so the
    // assertion must not depend on which side ranked first.
    const join = answer.joins.find(
      (entry) =>
        [entry.from, entry.to].sort().join("|") ===
        ["population_observation", "local_tax_revenue"].sort().join("|")
    );
    expect(join).toBeTruthy();
    expect(join!.joinKeys).toEqual(["region", "year"]);
    // The caveats are the point of the join graph: they must reach the answer.
    expect(answer.limitations.join(" ")).toContain("회계연도");
  });

  it("records the planner used so a route can be attributed", async () => {
    const answer = await runAgent(
      registry,
      "포항시 인구 2024년",
      new HeuristicPlanner()
    );
    expect(answer.planner).toBe("heuristic");
    expect(answer.consideredDatasets[0]!.matchedTerms.length).toBeGreaterThan(0);
  });

  it("does not count a tool call that matched nothing as evidence", async () => {
    // A search whose filter matches no row still succeeds; the response is just
    // empty. Treating that as evidence produced the answer "collected evidence
    // from X" with an empty source list, which is a claim nothing supports.
    const answer = await runAgent(
      registry,
      "상주시 34세 존재하지않는주제어zzz 정책 지원사업",
      fixedPlanner({
        steps: [
          {
            datasetId: "policy_program",
            tool: "search_policies",
            arguments: {
              region: "상주시",
              age: 34,
              query: "존재하지않는주제어zzz"
            },
            reason: "정책을 찾습니다"
          }
        ],
        unanswerable: null
      })
    );
    expect(answer.answered).toBe(false);
    expect(answer.evidence).toHaveLength(0);
    expect(answer.sources).toHaveLength(0);
    expect(answer.conclusion).not.toContain("근거를 수집했습니다");
    expect(answer.rejectedSteps.map((item) => item.reason).join(" ")).toContain(
      "조건에 맞는 데이터가 없어"
    );
  });

  it("never cites a source id that the answer does not carry", async () => {
    // Holds for every answered question, not just the population one: an id in
    // evidence that is absent from `sources` is an uncheckable citation.
    for (const question of [
      "포항시 인구는 2020년부터 2024년까지 어떻게 변했나?",
      "포항시 인구와 지방세를 2020년부터 2022년까지 비교해줘"
    ]) {
      const answer = await runAgent(registry, question, new HeuristicPlanner());
      const known = new Set(answer.sources.map((source) => source.sourceId));
      for (const item of answer.evidence) {
        expect(item.sourceIds.length).toBeGreaterThan(0);
        for (const sourceId of item.sourceIds) {
          expect(known.has(sourceId)).toBe(true);
        }
      }
    }
  });

  it("propagates a planner's own refusal without executing anything", async () => {
    const answer = await runAgent(
      registry,
      "포항시 인구 2024년",
      fixedPlanner({ steps: [], unanswerable: "모델이 답할 수 없다고 판단했습니다." })
    );
    expect(answer.answered).toBe(false);
    expect(answer.conclusion).toContain("모델이");
    expect(answer.evidence).toHaveLength(0);
  });
});
