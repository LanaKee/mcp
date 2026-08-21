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
          requiredSourceIds: ["population", "tax"]
        },
        {
          tool: "compare_population_and_tax",
          dataStatus: "demo_sample",
          sourceIds: ["population", "tax"]
        }
      ).passed
    ).toBe(true);
  });
});
