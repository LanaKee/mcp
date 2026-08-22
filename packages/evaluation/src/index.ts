export interface EvaluationCase {
  id: string;
  question: string;
  expectedTool: string;
  requiredSourceIds?: string[];
  expectedDataStatus?: "official_observed" | "demo_sample" | "catalog_only";
  expectedDerivedStatisticsAvailable?: boolean;
}

export interface EvaluationResult {
  id: string;
  passed: boolean;
  checks: Record<string, boolean>;
}

export function evaluateToolResult(
  testCase: EvaluationCase,
  actual: {
    tool: string;
    dataStatus?: string;
    sourceIds?: string[];
    derivedStatisticsAvailable?: boolean;
  }
): EvaluationResult {
  const checks = {
    tool: actual.tool === testCase.expectedTool,
    dataStatus:
      !testCase.expectedDataStatus || actual.dataStatus === testCase.expectedDataStatus,
    derivedStatistics:
      testCase.expectedDerivedStatisticsAvailable === undefined ||
      actual.derivedStatisticsAvailable ===
        testCase.expectedDerivedStatisticsAvailable,
    sources:
      !testCase.requiredSourceIds ||
      testCase.requiredSourceIds.every((sourceId) => actual.sourceIds?.includes(sourceId))
  };
  return { id: testCase.id, passed: Object.values(checks).every(Boolean), checks };
}

export * from "./benchmark.js";
