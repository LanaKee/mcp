import { describe, expect, it } from "vitest";
import type { AgentAnswer } from "./agent";
import { fallbackView } from "./fallback";

function answer(overrides: Partial<AgentAnswer> = {}): AgentAnswer {
  return {
    question: "포항시 인구 추세",
    planner: "heuristic",
    consideredDatasets: [],
    plan: [],
    answered: true,
    conclusion: "시군별 인구 관측에서 근거를 수집했습니다.",
    evidence: [],
    joins: [],
    sources: [],
    limitations: [],
    rejectedSteps: [],
    unavailableDatasets: [],
    ...overrides
  };
}

describe("fallbackView", () => {
  it("시계열 근거를 series 블록으로 옮긴다", () => {
    const view = fallbackView(
      answer({
        evidence: [
          {
            statement: "인구 추세",
            datasetId: "population_observation",
            tool: "get_population_trend",
            dataStatus: "official_observed",
            sourceIds: ["official:a"],
            detail: {
              region: "포항시",
              unit: "명",
              points: [
                { year: 2020, value: 508791 },
                { year: 2024, value: 499352 }
              ]
            }
          }
        ]
      })
    );

    const series = view.blocks.find((block) => block.kind === "series");
    expect(series).toBeDefined();
    if (series?.kind !== "series") throw new Error("series 블록이어야 한다");
    expect(series.points).toEqual([
      { label: "2020", value: 508791 },
      { label: "2024", value: 499352 }
    ]);
    expect(series.caption).toContain("499,352");
  });

  it("검색 결과 근거는 표로 옮긴다", () => {
    const view = fallbackView(
      answer({
        evidence: [
          {
            statement: "보도자료 검색",
            datasetId: "press_release",
            tool: "search_press_releases",
            dataStatus: "official_observed",
            sourceIds: [],
            detail: {
              matches: [{ title: "인구정책 기본계획 발표", publishedAt: "2024-03-02", department: "인구정책과" }]
            }
          }
        ]
      })
    );

    const table = view.blocks.find((block) => block.kind === "table");
    if (table?.kind !== "table") throw new Error("table 블록이어야 한다");
    expect(table.rows[0]).toEqual(["2024-03-02", "인구정책 기본계획 발표", "인구정책과"]);
  });

  it("답을 낸 경우에는 비어 있는 데이터셋을 알리지 않는다", () => {
    // 답이 나온 화면에서 이것은 질문에 대한 정보가 아니라 우리 적재 상태에 관한
    // 내부 사정이다. 경고처럼 보이게 두면 답을 의심하게 만든다.
    const view = fallbackView(
      answer({
        unavailableDatasets: [
          { datasetId: "policy_program", title: "정책 사업", note: "행이 없습니다." }
        ]
      })
    );

    expect(view.blocks.find((block) => block.kind === "callout")).toBeUndefined();
  });

  it("답하지 못한 경우에는 무엇이 비어 있어서인지 밝힌다", () => {
    // 이때는 같은 사실이 곧 답할 수 없는 이유이므로 감추면 안 된다.
    const view = fallbackView(
      answer({
        answered: false,
        conclusion: "답할 수 없습니다.",
        unavailableDatasets: [
          { datasetId: "policy_program", title: "정책 사업", note: "행이 없습니다." }
        ]
      })
    );

    const callout = view.blocks.find((block) => block.kind === "callout");
    if (callout?.kind !== "callout") throw new Error("callout 블록이어야 한다");
    expect(callout.tone).toBe("warn");
    expect(callout.title).toContain("정책 사업");
  });

  it("답하지 못한 질문은 그 사실을 부제로 밝힌다", () => {
    const view = fallbackView(answer({ answered: false, conclusion: "답할 수 없습니다." }));
    const headline = view.blocks[0];
    if (headline?.kind !== "headline") throw new Error("headline 블록이어야 한다");
    expect(headline.subtitle).toContain("답할 수 없습니다");
  });
});
