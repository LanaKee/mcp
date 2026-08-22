import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseBenchmarkCases,
  scoreBenchmarkCase,
  summarizeBenchmark,
  type BenchmarkCase,
  type BenchmarkObservation
} from "./benchmark.js";

function observation(
  overrides: Partial<BenchmarkObservation> = {}
): BenchmarkObservation {
  return {
    question: "질문",
    planner: "test",
    consideredDatasets: [{ datasetId: "population_observation" }],
    plan: [
      {
        datasetId: "population_observation",
        tool: "get_population_trend",
        arguments: { region: "포항시", startYear: 2018, endYear: 2024 }
      }
    ],
    answered: true,
    conclusion: "시군별 인구 관측에서 근거를 수집했습니다.",
    evidence: [
      {
        datasetId: "population_observation",
        tool: "get_population_trend",
        dataStatus: "official_observed",
        sourceIds: ["official:aaa"]
      }
    ],
    joins: [],
    sources: [{ sourceId: "official:aaa" }],
    limitations: [],
    rejectedSteps: [],
    unavailableDatasets: [],
    ...overrides
  };
}

const trendCase: BenchmarkCase = {
  id: "pop",
  question: "질문",
  intent: "single_dataset_trend",
  expectedDatasets: ["population_observation"],
  expectedTools: ["get_population_trend"],
  expectedArguments: { region: "포항시", startYear: 2018, endYear: 2024 },
  expectedDataStatus: "official_observed",
  manualBaselineMinutes: 18
};

function check(result: ReturnType<typeof scoreBenchmarkCase>, name: string) {
  return result.checks.find((entry) => entry.name === name);
}

describe("scoreBenchmarkCase", () => {
  it("passes a fully correct single-dataset run", () => {
    const result = scoreBenchmarkCase(trendCase, observation(), 2500);
    expect(result.passed).toBe(true);
    expect(check(result, "dataset_recall_at_5")?.passed).toBe(true);
    expect(check(result, "tool_selection")?.passed).toBe(true);
    expect(check(result, "citation_integrity")?.passed).toBe(true);
  });

  it("fails discovery when the catalog never surfaced the needed dataset", () => {
    const result = scoreBenchmarkCase(
      trendCase,
      observation({ consideredDatasets: [{ datasetId: "press_release" }] }),
      100
    );
    expect(check(result, "dataset_recall_at_5")?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("fails argument selection when a step used the wrong region", () => {
    const result = scoreBenchmarkCase(
      trendCase,
      observation({
        plan: [
          {
            datasetId: "population_observation",
            tool: "get_population_trend",
            arguments: { region: "안동시", startYear: 2018, endYear: 2024 }
          }
        ]
      }),
      100
    );
    const argumentCheck = check(result, "argument_selection");
    expect(argumentCheck?.passed).toBe(false);
    expect(argumentCheck?.detail).toContain("안동시");
  });

  it("fails when only one of two joined steps carries the right region", () => {
    const crossCase: BenchmarkCase = {
      ...trendCase,
      id: "cross",
      intent: "cross_dataset",
      expectedDatasets: ["population_observation", "local_tax_revenue"],
      expectedTools: ["get_population_trend", "get_local_tax_revenue_trend"],
      expectedJoin: {
        datasets: ["population_observation", "local_tax_revenue"],
        joinKeys: ["region", "year"]
      },
      manualBaselineMinutes: 45
    };
    const result = scoreBenchmarkCase(
      crossCase,
      observation({
        consideredDatasets: [
          { datasetId: "population_observation" },
          { datasetId: "local_tax_revenue" }
        ],
        plan: [
          {
            datasetId: "population_observation",
            tool: "get_population_trend",
            arguments: { region: "포항시", startYear: 2018, endYear: 2024 }
          },
          {
            datasetId: "local_tax_revenue",
            tool: "get_local_tax_revenue_trend",
            arguments: { region: "경주시", startYear: 2018, endYear: 2024 }
          }
        ]
      }),
      100
    );
    expect(check(result, "argument_selection")?.passed).toBe(false);
  });

  it("accepts a declared join in either direction", () => {
    const crossCase: BenchmarkCase = {
      ...trendCase,
      id: "cross",
      intent: "cross_dataset",
      expectedDatasets: ["population_observation", "local_tax_revenue"],
      expectedTools: [],
      expectedArguments: undefined,
      expectedJoin: {
        datasets: ["population_observation", "local_tax_revenue"],
        joinKeys: ["region", "year"]
      },
      manualBaselineMinutes: 45
    };
    const reversed = scoreBenchmarkCase(
      crossCase,
      observation({
        consideredDatasets: [
          { datasetId: "population_observation" },
          { datasetId: "local_tax_revenue" }
        ],
        evidence: [
          {
            datasetId: "population_observation",
            tool: "get_population_trend",
            dataStatus: "official_observed",
            sourceIds: ["official:aaa"]
          },
          {
            datasetId: "local_tax_revenue",
            tool: "get_local_tax_revenue_trend",
            dataStatus: "official_observed",
            sourceIds: ["official:bbb"]
          }
        ],
        joins: [
          {
            from: "local_tax_revenue",
            to: "population_observation",
            joinKeys: ["region", "year"]
          }
        ],
        sources: [{ sourceId: "official:aaa" }, { sourceId: "official:bbb" }]
      }),
      100
    );
    expect(check(reversed, "join_accuracy")?.passed).toBe(true);
    expect(check(reversed, "join_datasets_executed")?.passed).toBe(true);
  });

  it("catches a citation that points at a source not in the answer", () => {
    const result = scoreBenchmarkCase(
      trendCase,
      observation({ sources: [{ sourceId: "official:other" }] }),
      100
    );
    expect(check(result, "citation_integrity")?.passed).toBe(false);
  });

  it("fails an answer that cites nothing at all", () => {
    const result = scoreBenchmarkCase(
      trendCase,
      observation({ sources: [], evidence: [] }),
      100
    );
    expect(check(result, "citation_integrity")?.passed).toBe(false);
  });

  it("scores a correct refusal as a pass", () => {
    const refusal: BenchmarkCase = {
      id: "refuse",
      question: "화성에서 물을 어떻게 구하나?",
      intent: "refusal",
      expectedDatasets: [],
      expectAnswerable: false,
      manualBaselineMinutes: 5
    };
    const result = scoreBenchmarkCase(
      refusal,
      observation({
        consideredDatasets: [],
        plan: [],
        answered: false,
        conclusion: "이 질문에 답할 수 있는 데이터셋을 카탈로그에서 찾지 못했습니다.",
        evidence: [],
        sources: []
      }),
      50
    );
    expect(result.passed).toBe(true);
    expect(check(result, "answerability")?.passed).toBe(true);
    // Checks that only make sense for an answer must not drag a refusal down.
    expect(check(result, "citation_integrity")?.passed).toBeNull();
    expect(check(result, "tool_selection")?.passed).toBeNull();
  });

  it("fails a refusal case that answered anyway", () => {
    const refusal: BenchmarkCase = {
      id: "refuse",
      question: "국세",
      intent: "refusal",
      expectedDatasets: [],
      expectAnswerable: false,
      manualBaselineMinutes: 10
    };
    const result = scoreBenchmarkCase(refusal, observation(), 50);
    expect(check(result, "answerability")?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("flags a numeric claim made with no evidence behind it", () => {
    const result = scoreBenchmarkCase(
      trendCase,
      observation({
        evidence: [],
        sources: [],
        conclusion: "포항시 인구는 2024년 489,720명입니다."
      }),
      100
    );
    expect(check(result, "no_unsupported_claim")?.passed).toBe(false);
  });

  it("does not flag numbers that came with evidence", () => {
    const result = scoreBenchmarkCase(
      trendCase,
      observation({ conclusion: "2018~2024년 근거 1건을 수집했습니다." }),
      100
    );
    expect(check(result, "no_unsupported_claim")?.passed).toBe(true);
  });

  it("credits time saved only for cases that actually passed", () => {
    const passing = scoreBenchmarkCase(trendCase, observation(), 60_000);
    expect(passing.minutesSaved).toBeCloseTo(17, 5);
    const failing = scoreBenchmarkCase(
      trendCase,
      observation({ consideredDatasets: [] }),
      60_000
    );
    expect(failing.minutesSaved).toBe(0);
  });

  it("never reports negative savings when the agent is slower than a person", () => {
    const slow = scoreBenchmarkCase(trendCase, observation(), 30 * 60_000);
    expect(slow.minutesSaved).toBe(0);
  });
});

describe("summarizeBenchmark", () => {
  it("computes per-check rates only over cases where the check applied", () => {
    const answered = scoreBenchmarkCase(trendCase, observation(), 1000);
    const refusal = scoreBenchmarkCase(
      {
        id: "refuse",
        question: "q",
        intent: "refusal",
        expectedDatasets: [],
        expectAnswerable: false,
        manualBaselineMinutes: 5
      },
      observation({
        consideredDatasets: [],
        plan: [],
        answered: false,
        conclusion: "찾지 못했습니다.",
        evidence: [],
        sources: []
      }),
      500
    );
    const report = summarizeBenchmark("test", [answered, refusal]);
    expect(report.totalCases).toBe(2);
    expect(report.passedCases).toBe(2);
    // tool_selection applied to the answered case only.
    expect(report.checkRates.tool_selection?.applicable).toBe(1);
    // answerability and discovery applied to both.
    expect(report.checkRates.answerability?.applicable).toBe(2);
    expect(report.medianElapsedMs).toBe(500);
  });
});

describe("evals/benchmark.jsonl", () => {
  const cases = parseBenchmarkCases(
    readFileSync(new URL("../../../evals/benchmark.jsonl", import.meta.url), "utf8")
  );

  it("has at least ten questions", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  it("uses unique ids", () => {
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
  });

  it("covers single-dataset, cross-dataset, search, and refusal intents", () => {
    const intents = new Set(cases.map((entry) => entry.intent));
    expect(intents.has("single_dataset_trend")).toBe(true);
    expect(intents.has("cross_dataset")).toBe(true);
    expect(intents.has("document_search")).toBe(true);
    expect(intents.has("refusal")).toBe(true);
  });

  it("flags an empty candidate dataset that the answer never disclosed", () => {
    const partial: BenchmarkCase = {
      ...trendCase,
      id: "partial",
      intent: "partial_coverage",
      expectedUnavailableDatasets: ["policy_program"]
    };
    const hidden = scoreBenchmarkCase(partial, observation(), 100);
    expect(check(hidden, "unavailable_disclosed")?.passed).toBe(false);
    const disclosed = scoreBenchmarkCase(
      partial,
      observation({ unavailableDatasets: [{ datasetId: "policy_program" }] }),
      100
    );
    expect(check(disclosed, "unavailable_disclosed")?.passed).toBe(true);
  });

  it("requires a stated disclosure such as the real coverage range", () => {
    const withMention: BenchmarkCase = {
      ...trendCase,
      id: "mention",
      expectedMentions: ["2025~2026"]
    };
    const silent = scoreBenchmarkCase(withMention, observation(), 100);
    expect(check(silent, "required_disclosure")?.passed).toBe(false);
    const stated = scoreBenchmarkCase(
      withMention,
      observation({ limitations: ["울진군 인구는 2025~2026년만 적재되어 있습니다."] }),
      100
    );
    expect(check(stated, "required_disclosure")?.passed).toBe(true);
  });
});

describe("evals/benchmark.jsonl extra", () => {
  const cases = parseBenchmarkCases(
    readFileSync(new URL("../../../evals/benchmark.jsonl", import.meta.url), "utf8")
  );

  it("gives every case a manual baseline so time saved is defensible", () => {
    for (const entry of cases) {
      expect(entry.manualBaselineMinutes).toBeGreaterThan(0);
      expect(entry.manualBaselineRationale ?? "").not.toHaveLength(0);
    }
  });

  it("declares expected tools for every answerable case", () => {
    for (const entry of cases) {
      if (entry.expectAnswerable === false) continue;
      expect(entry.expectedTools?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("only expects joins between datasets it also expects to be discovered", () => {
    for (const entry of cases) {
      if (!entry.expectedJoin) continue;
      for (const datasetId of entry.expectedJoin.datasets) {
        expect(entry.expectedDatasets).toContain(datasetId);
      }
    }
  });
});

describe("refusals may state numbers", () => {
  it("does not treat a declined answer's coverage range as an unsupported claim", () => {
    const refusal: BenchmarkCase = {
      id: "uljin",
      question: "울진군 인구 2015~2024",
      intent: "partial_coverage",
      expectedDatasets: ["population_observation"],
      expectAnswerable: false,
      manualBaselineMinutes: 18
    };
    const result = scoreBenchmarkCase(
      refusal,
      observation({
        answered: false,
        evidence: [],
        sources: [],
        conclusion:
          "울진군 시군별 인구 관측은(는) 2025~2026년만 적재되어 있어 요청하신 2015~2024년 구간은 답할 수 없습니다."
      }),
      100
    );
    expect(check(result, "no_unsupported_claim")?.passed).toBe(true);
    expect(result.passed).toBe(true);
  });
});
