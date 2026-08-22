import { describe, expect, it } from "vitest";
import { evaluateToolResult } from "./index.js";

describe("evaluation contract", () => {
  it("requires the expected tool, status and sources", () => {
    expect(
      evaluateToolResult(
        {
          id: "case",
          question: "질문",
          expectedTool: "compare_population_and_tax",
          expectedDataStatus: "demo_sample",
          expectedDerivedStatisticsAvailable: false,
          requiredSourceIds: ["population", "tax"]
        },
        {
          tool: "compare_population_and_tax",
          dataStatus: "demo_sample",
          derivedStatisticsAvailable: false,
          sourceIds: ["population", "tax"]
        }
      ).passed
    ).toBe(true);
  });

  it("fails when an evaluation exposes forbidden derived statistics", () => {
    const result = evaluateToolResult(
      {
        id: "mixed",
        question: "질문",
        expectedTool: "compare_population_and_tax",
        expectedDerivedStatisticsAvailable: false
      },
      {
        tool: "compare_population_and_tax",
        derivedStatisticsAvailable: true
      }
    );
    expect(result.passed).toBe(false);
    expect(result.checks.derivedStatistics).toBe(false);
  });
});
