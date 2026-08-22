import { beforeAll, describe, expect, it } from "vitest";
import { loadDemoData, type DemoDataStore } from "./data-store.js";
import { InMemoryDataRepository } from "./repository.js";
import { createToolRegistry, executeTool, type ToolRegistry } from "./tools.js";
import {
  buildRegionalEvidencePack,
  draftFromEvidencePack,
  type RegionalEvidencePack
} from "./evidence-pack.js";

describe("regional evidence pack", () => {
  let store: DemoDataStore;
  let registry: ToolRegistry;

  beforeAll(async () => {
    store = await loadDemoData();
    registry = createToolRegistry(new InMemoryDataRepository(store));
  });

  const build = (input: Record<string, unknown>) =>
    buildRegionalEvidencePack(registry, {
      region: "포항시",
      issue: "인구 감소",
      startYear: 2022,
      endYear: 2024,
      // The demo fixtures are demo_sample; operations run official-only, so the
      // filter has to be widened explicitly here for the fixtures to be visible.
      dataStatuses: ["demo_sample"],
      ...input
    } as Parameters<typeof buildRegionalEvidencePack>[1]);

  it("separates observed statistics from narrative context by evidence role", async () => {
    const pack = await build({});
    for (const node of pack.observed) expect(node.role).toBe("observed_fact");
    for (const node of pack.context)
      expect(node.role).toBe("narrative_context_only");
  });

  it("gives every node the claim boundary that applies to it", async () => {
    const pack = await build({});
    const nodes = [...pack.observed, ...pack.context];
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.contract.canClaim.length).toBeGreaterThan(0);
      expect(node.contract.cannotClaim.length).toBeGreaterThan(0);
      expect(node.sourceIds.length).toBeGreaterThan(0);
    }
  });

  it("names a gap when a region has no statistical footing at all", async () => {
    const pack = await build({ region: "존재하지않는군" });
    expect(pack.observed).toHaveLength(0);
    const questions = pack.gaps.map((gap) => gap.question).join(" ");
    expect(questions).toContain("수치로 뒷받침되는 결론");
  });

  it("names the missing-observation gap for a probed but empty statistical dataset", async () => {
    const pack = await build({ region: "존재하지않는군" });
    const reasons = pack.gaps.map((gap) => gap.reason);
    expect(reasons).toContain("해당 지역·기간에 적재된 관측이 없습니다.");
  });

  it("asks for the record before proposing spending", async () => {
    const pack = await build({});
    if (pack.recommendedActions.length === 0) return;
    expect(pack.recommendedActions[0]!.action).toBe("정보공개청구");
    const budget = pack.recommendedActions.findIndex(
      (action) => action.action === "주민참여예산 제안"
    );
    if (budget >= 0) expect(budget).toBeGreaterThan(0);
  });

  it("never recommends an action when nothing is missing", async () => {
    const pack = await build({});
    if (pack.gaps.length === 0) expect(pack.recommendedActions).toHaveLength(0);
  });

  it("refuses to let narrative material stand as a numeric claim", async () => {
    const pack = await build({});
    if (pack.context.length === 0) return;
    expect(
      pack.limitations.some((limitation) => limitation.includes("관측 통계로 인용해서는 안 됩니다"))
    ).toBe(true);
    expect(
      pack.limitations.some((limitation) => limitation.includes("구조화된 지역 태그"))
    ).toBe(true);
  });

  it("carries every cited source so a reader can reach the original", async () => {
    const pack = await build({});
    const cited = new Set(
      [...pack.observed, ...pack.context].flatMap((node) => node.sourceIds)
    );
    const carried = new Set(pack.sources.map((source) => source.sourceId));
    for (const sourceId of cited) expect(carried.has(sourceId)).toBe(true);
  });

  it("is reachable as a tool and reports the gap caveat in its limitations", async () => {
    const response = await executeTool(registry, "build_regional_evidence_pack", {
      region: "포항시",
      issue: "인구 감소",
      startYear: 2022,
      endYear: 2024,
      dataStatuses: ["demo_sample"]
    });
    const pack = response.result as RegionalEvidencePack;
    expect(pack.region).toBe("포항시");
    expect(
      response.limitations.some((limitation) =>
        limitation.includes("세상에 없다는 뜻이 아닙니다")
      )
    ).toBe(true);
  });
});

describe("drafting a civic document from a pack", () => {
  const officialSource = {
    sourceId: "s-1",
    title: "인구 통계",
    provider: "경상북도",
    sourceUrl: null,
    collectedAt: "2025-01-01",
    dataStatus: "official_observed" as const,
    isOfficial: true,
    locator: "row 1"
  };

  const pack = (overrides: Partial<RegionalEvidencePack> = {}) =>
    ({
      region: "포항시",
      issue: "인구 감소",
      period: { startYear: 2018, endYear: 2024 },
      observed: [
        {
          datasetId: "population_observation",
          title: "시군별 인구 관측",
          tool: "get_population_trend",
          role: "observed_fact",
          dataStatus: "official_observed",
          summary: "인구 관측 7개 연도",
          itemCount: 7,
          sourceIds: ["s-1"],
          contract: { role: "observed_fact", canClaim: ["a"], cannotClaim: ["b"] },
          detail: {}
        }
      ],
      context: [],
      links: [],
      gaps: [
        {
          question: "집행되었는가?",
          reason: "집행 실적 데이터가 없습니다.",
          wouldBeClosedBy: "사업별 예산 집행 내역",
          holder: "포항시"
        }
      ],
      recommendedActions: [],
      sources: [officialSource],
      limitations: ["한계 1"],
      dataStatuses: ["official_observed"],
      ...overrides
    }) as unknown as RegionalEvidencePack;

  it("builds a disclosure request out of the gaps, not the findings", () => {
    const prepared = draftFromEvidencePack(pack(), "information_request");
    expect(prepared.verifiedAnalysis.conclusion).toContain("집행되었는가?");
    expect(
      prepared.verifiedAnalysis.evidence.some((item) =>
        item.statement.includes("사업별 예산 집행 내역")
      )
    ).toBe(true);
  });

  it("refuses a budget proposal that rests on announcements alone", () => {
    expect(() =>
      draftFromEvidencePack(pack({ observed: [] }), "participatory_budget")
    ).toThrow(/근거 없는 요구/);
  });

  it("warns a budget proposal about what is still unverified", () => {
    const prepared = draftFromEvidencePack(pack(), "participatory_budget");
    expect(prepared.verifiedAnalysis.limitations[0]).toContain(
      "정보공개청구로 확인한 뒤"
    );
  });

  it("refuses to draft anything from demo or unofficial sources", () => {
    expect(() =>
      draftFromEvidencePack(
        pack({
          sources: [{ ...officialSource, dataStatus: "demo_sample" }]
        } as unknown as Partial<RegionalEvidencePack>),
        "information_request"
      )
    ).toThrow(/공식 출처가 없어/);
  });

  it("refuses a disclosure request when nothing is missing", () => {
    expect(() =>
      draftFromEvidencePack(pack({ gaps: [] }), "information_request")
    ).toThrow(/청구할 근거 공백이 없습니다/);
  });
});
