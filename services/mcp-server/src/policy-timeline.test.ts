import { beforeAll, describe, expect, it } from "vitest";
import { loadDemoData, type DemoDataStore } from "./data-store.js";
import { InMemoryDataRepository } from "./repository.js";
import { createToolRegistry, executeTool, type ToolRegistry } from "./tools.js";
import { tracePolicyResponse, type PolicyTimeline } from "./policy-timeline.js";

describe("policy response timeline", () => {
  let store: DemoDataStore;
  let registry: ToolRegistry;

  beforeAll(async () => {
    store = await loadDemoData();
    registry = createToolRegistry(new InMemoryDataRepository(store));
  });

  const trace = (input: Record<string, unknown> = {}) =>
    tracePolicyResponse(registry, {
      region: "포항시",
      issue: "인구",
      dataStatuses: ["demo_sample"],
      ...input
    });

  it("orders every record by date regardless of which stage produced it", async () => {
    const timeline = await trace();
    const dates = timeline.entries.map((entry) => entry.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("classifies a record by its source dataset, never by its own wording", async () => {
    const timeline = await trace();
    const byStage: Record<string, string> = {
      document_chunk: "plan",
      press_release: "announcement",
      council_record: "deliberation",
      council_bill: "legislation"
    };
    for (const entry of timeline.entries) {
      expect(entry.stage).toBe(byStage[entry.datasetId]);
    }
  });

  it("states what each entry establishes so it cannot be over-read", async () => {
    const timeline = await trace();
    for (const entry of timeline.entries) {
      expect(entry.establishes.length).toBeGreaterThan(0);
      expect(entry.sourceId).not.toBe("");
    }
  });

  it("never returns an outcome assessment and says why", async () => {
    const timeline = await trace();
    expect(timeline.outcomeAssessment).toBeNull();
    expect(timeline.outcomeAssessmentUnavailableReason).toContain("성과지표");
  });

  it("names the stages that produced nothing instead of leaving them blank", async () => {
    const timeline = await trace({ issue: "존재하지않는주제어xyz" });
    expect(timeline.entries).toHaveLength(0);
    expect(timeline.missingStages.sort()).toEqual([
      "announcement",
      "deliberation",
      "legislation",
      "plan"
    ]);
    expect(
      timeline.limitations.some((limitation) =>
        limitation.includes("기록을 찾지 못한 단계")
      )
    ).toBe(true);
  });

  it("warns that a missing record is not proof the stage did not happen", async () => {
    const timeline = await trace();
    expect(
      timeline.limitations.some((limitation) =>
        limitation.includes("그 단계가 없었다는 증명은 아닙니다")
      )
    ).toBe(true);
  });

  it("keeps stage counts consistent with the entries it returned", async () => {
    const timeline = await trace();
    const counted = timeline.entries.reduce<Record<string, number>>(
      (totals, entry) => ({
        ...totals,
        [entry.stage]: (totals[entry.stage] ?? 0) + 1
      }),
      {}
    );
    for (const [stage, count] of Object.entries(timeline.stageCounts)) {
      expect(count).toBe(counted[stage] ?? 0);
    }
  });

  it("is reachable as a tool and refuses to grade the response", async () => {
    const response = await executeTool(registry, "trace_policy_response", {
      region: "포항시",
      issue: "인구",
      dataStatuses: ["demo_sample"]
    });
    const timeline = response.result as PolicyTimeline;
    expect(timeline.outcomeAssessment).toBeNull();
    expect(
      response.limitations.some((limitation) =>
        limitation.includes("성과를 냈는지는 이 자료로 판단할 수 없습니다")
      )
    ).toBe(true);
  });
});
