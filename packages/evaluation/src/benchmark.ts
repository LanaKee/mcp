/**
 * Agent benchmark scoring.
 *
 * The original `evaluateToolResult` only asked "did the expected tool run".
 * That answers nothing about the claim this project actually makes, which is
 * that an agent can *find* the right data, *combine* it correctly, and *cite*
 * it honestly. So this module scores the whole trail an agent produces, and
 * scores refusals as first-class successes rather than failures — a system that
 * answers a question it has no data for is worse than one that declines.
 */

export type BenchmarkIntent =
  | "single_dataset_trend"
  | "cross_dataset"
  | "document_search"
  | "refusal"
  | "partial_coverage";

export interface BenchmarkCase {
  id: string;
  question: string;
  intent: BenchmarkIntent;
  /** Datasets that must appear among the catalog candidates. */
  expectedDatasets: string[];
  expectedTools?: string[];
  /** Arguments the executed plan must carry, e.g. region/startYear/endYear. */
  expectedArguments?: Record<string, unknown>;
  expectedDataStatus?: string;
  expectedJoin?: { datasets: string[]; joinKeys: string[] };
  /**
   * Datasets that hold no rows and must be named as such in the answer.
   *
   * Silently answering from an adjacent dataset is the failure mode this
   * catches: a user asking for policy announcements must be told the
   * announcements table is empty, even when press releases were returned.
   */
  expectedUnavailableDatasets?: string[];
  /** Substrings the conclusion or limitations must contain, e.g. the real year range. */
  expectedMentions?: string[];
  /** Defaults to true; false means the correct behaviour is to decline. */
  expectAnswerable?: boolean;
  /** Minutes the same question takes a person using the original sources. */
  manualBaselineMinutes: number;
  manualBaselineRationale?: string;
}

/** The subset of an AgentAnswer the scorer needs, so this package stays free of a server dependency. */
export interface BenchmarkObservation {
  question: string;
  planner: string;
  consideredDatasets: Array<{ datasetId: string }>;
  plan: Array<{
    datasetId: string;
    tool: string;
    arguments: Record<string, unknown>;
  }>;
  answered: boolean;
  conclusion: string;
  evidence: Array<{ datasetId: string; tool: string; dataStatus: string; sourceIds: string[] }>;
  joins: Array<{ from: string; to: string; joinKeys: string[] }>;
  sources: Array<{ sourceId: string }>;
  limitations: string[];
  rejectedSteps: Array<{ reason: string }>;
  unavailableDatasets: Array<{ datasetId: string }>;
}

export interface BenchmarkCheck {
  name: string;
  /** null means the check does not apply to this case and is excluded from the score. */
  passed: boolean | null;
  detail: string;
}

export interface BenchmarkCaseResult {
  id: string;
  intent: BenchmarkIntent;
  passed: boolean;
  checks: BenchmarkCheck[];
  elapsedMs: number;
  manualBaselineMinutes: number;
  /** Minutes saved versus doing it by hand, floored at zero. */
  minutesSaved: number;
}

const NUMERIC_TOKEN = /\d[\d,]*(?:\.\d+)?/g;

function applicable(checks: BenchmarkCheck[]): BenchmarkCheck[] {
  return checks.filter((check) => check.passed !== null);
}

/**
 * True when the conclusion asserts a figure that no executed step produced.
 *
 * A cited-looking sentence containing an uncited number is the single most
 * damaging failure mode for a public-data system, so it is measured directly
 * instead of being folded into a generic "quality" score.
 */
function hasUnsupportedNumericClaim(observation: BenchmarkObservation): boolean {
  if (observation.evidence.length > 0) return false;
  // A declined answer is an explanation, not a claim. Refusals are *expected*
  // to contain numbers — "울진군 인구는 2025~2026년만 적재되어 있습니다" is the
  // most useful possible refusal, and penalising it would push the system
  // toward vaguer, less actionable declines.
  if (!observation.answered) return false;
  const numbers = observation.conclusion.match(NUMERIC_TOKEN) ?? [];
  return numbers.length > 0;
}

function argumentsMatch(
  expected: Record<string, unknown>,
  plan: BenchmarkObservation["plan"]
): { passed: boolean; detail: string } {
  const missing: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    // Every executed step that accepts the argument must carry the expected
    // value; a plan that gets the region right for population and wrong for tax
    // produces an invalid comparison, so "some step matched" is not enough.
    const relevant = plan.filter((step) => step.arguments[key] !== undefined);
    if (relevant.length === 0) {
      missing.push(`${key} 미지정`);
      continue;
    }
    const mismatched = relevant.filter((step) => step.arguments[key] !== value);
    if (mismatched.length > 0) {
      missing.push(
        `${key}=${String(mismatched[0]?.arguments[key])} (기대 ${String(value)})`
      );
    }
  }
  return {
    passed: missing.length === 0,
    detail: missing.length === 0 ? "모든 실행 인자 일치" : missing.join(", ")
  };
}

export function scoreBenchmarkCase(
  testCase: BenchmarkCase,
  observation: BenchmarkObservation,
  elapsedMs: number
): BenchmarkCaseResult {
  const expectAnswerable = testCase.expectAnswerable ?? true;
  const consideredIds = observation.consideredDatasets.map((entry) => entry.datasetId);
  const executedDatasets = new Set(observation.evidence.map((entry) => entry.datasetId));
  const executedTools = new Set(observation.evidence.map((entry) => entry.tool));
  const checks: BenchmarkCheck[] = [];

  // 1. Retrieval recall@5 — did the catalog surface the right dataset among the
  //    five candidates the planner is given? Everything downstream depends on
  //    this, so it is reported with the rank each expected dataset landed at:
  //    a dataset recalled at rank 5 is a weaker result than one at rank 1 even
  //    though both pass, and a rank drift is the earliest warning that lexical
  //    ranking is degrading.
  if (testCase.expectedDatasets.length > 0) {
    const ranks = testCase.expectedDatasets.map((id) => ({
      id,
      rank: consideredIds.indexOf(id) + 1
    }));
    const missing = ranks.filter((entry) => entry.rank === 0);
    checks.push({
      name: "dataset_recall_at_5",
      passed: missing.length === 0,
      detail:
        missing.length === 0
          ? `순위 ${ranks.map((entry) => `${entry.id}#${entry.rank}`).join(", ")}`
          : `누락 ${missing.map((entry) => entry.id).join(", ")} / 후보 ${consideredIds.join(", ") || "없음"}`
    });
  } else {
    // For an out-of-scope question, surfacing no candidate is the correct
    // retrieval behaviour.
    checks.push({
      name: "dataset_recall_at_5",
      passed: consideredIds.length === 0,
      detail: consideredIds.length === 0 ? "후보 없음 (정답)" : `불필요한 후보: ${consideredIds.join(", ")}`
    });
  }

  // 2. Answerability — refusals are scored as successes when refusing is right.
  checks.push({
    name: "answerability",
    passed: observation.answered === expectAnswerable,
    detail: expectAnswerable
      ? observation.answered
        ? "답변함 (기대대로)"
        : `답변 실패: ${observation.conclusion}`
      : observation.answered
        ? `거부해야 하는데 답변함: ${observation.conclusion}`
        : "정확히 거부함"
  });

  // 3. Tool selection — only meaningful when an answer was expected.
  if (expectAnswerable && testCase.expectedTools?.length) {
    const missing = testCase.expectedTools.filter((tool) => !executedTools.has(tool));
    checks.push({
      name: "tool_selection",
      passed: missing.length === 0,
      detail: missing.length === 0
        ? `실행 ${[...executedTools].join(", ")}`
        : `누락 ${missing.join(", ")} / 실행 ${[...executedTools].join(", ") || "없음"}`
    });
  } else {
    checks.push({ name: "tool_selection", passed: null, detail: "해당 없음" });
  }

  // 4. Argument selection (region / year window).
  if (expectAnswerable && testCase.expectedArguments) {
    const result = argumentsMatch(testCase.expectedArguments, observation.plan);
    checks.push({ name: "argument_selection", ...result });
  } else {
    checks.push({ name: "argument_selection", passed: null, detail: "해당 없음" });
  }

  // 5. Cross-dataset join correctness.
  if (testCase.expectedJoin) {
    const [a, b] = testCase.expectedJoin.datasets;
    const join = observation.joins.find(
      (entry) =>
        (entry.from === a && entry.to === b) || (entry.from === b && entry.to === a)
    );
    const keysMatch =
      join !== undefined &&
      testCase.expectedJoin.joinKeys.every((key) => join.joinKeys.includes(key));
    checks.push({
      name: "join_accuracy",
      passed: keysMatch,
      detail: join
        ? `조인 ${join.from}<->${join.to} on ${join.joinKeys.join(",")}`
        : "선언된 조인이 사용되지 않음"
    });
    checks.push({
      name: "join_datasets_executed",
      passed: testCase.expectedJoin.datasets.every((id) => executedDatasets.has(id)),
      detail: `실행된 데이터셋 ${[...executedDatasets].join(", ") || "없음"}`
    });
  } else {
    checks.push({ name: "join_accuracy", passed: null, detail: "해당 없음" });
    checks.push({ name: "join_datasets_executed", passed: null, detail: "해당 없음" });
  }

  // 6. Citation integrity — every source id an evidence item leans on must be
  //    resolvable in the answer's source list, and an answer must cite at least
  //    one source.
  if (expectAnswerable) {
    const resolvable = new Set(observation.sources.map((source) => source.sourceId));
    const dangling = observation.evidence
      .flatMap((entry) => entry.sourceIds)
      .filter((sourceId) => !resolvable.has(sourceId));
    const cited = observation.sources.length > 0;
    checks.push({
      name: "citation_integrity",
      passed: dangling.length === 0 && cited,
      detail: dangling.length > 0
        ? `해석 불가 출처 ${dangling.length}건`
        : cited
          ? `출처 ${observation.sources.length}건 모두 해석 가능`
          : "출처 없음"
    });
  } else {
    checks.push({ name: "citation_integrity", passed: null, detail: "해당 없음" });
  }

  // 7. Data status honesty.
  if (expectAnswerable && testCase.expectedDataStatus) {
    const statuses = new Set(observation.evidence.map((entry) => entry.dataStatus));
    checks.push({
      name: "data_status",
      passed:
        statuses.size > 0 && [...statuses].every((s) => s === testCase.expectedDataStatus),
      detail: `상태 ${[...statuses].join(", ") || "없음"} / 기대 ${testCase.expectedDataStatus}`
    });
  } else {
    checks.push({ name: "data_status", passed: null, detail: "해당 없음" });
  }

  // 8. Empty datasets that were candidates must be disclosed.
  if (testCase.expectedUnavailableDatasets?.length) {
    const reported = new Set(
      observation.unavailableDatasets.map((entry) => entry.datasetId)
    );
    const missing = testCase.expectedUnavailableDatasets.filter(
      (id) => !reported.has(id)
    );
    checks.push({
      name: "unavailable_disclosed",
      passed: missing.length === 0,
      detail: missing.length === 0
        ? `빈 데이터셋 공개: ${[...reported].join(", ")}`
        : `공개되지 않은 빈 데이터셋 ${missing.join(", ")}`
    });
  } else {
    checks.push({ name: "unavailable_disclosed", passed: null, detail: "해당 없음" });
  }

  // 9. Required disclosures, e.g. the actual coverage the user should ask for.
  if (testCase.expectedMentions?.length) {
    const haystack = [observation.conclusion, ...observation.limitations].join(" ");
    const missing = testCase.expectedMentions.filter(
      (needle) => !haystack.includes(needle)
    );
    checks.push({
      name: "required_disclosure",
      passed: missing.length === 0,
      detail: missing.length === 0 ? "필수 고지 포함" : `누락 ${missing.join(", ")}`
    });
  } else {
    checks.push({ name: "required_disclosure", passed: null, detail: "해당 없음" });
  }

  // 10. No unsupported claim — applies to every case including refusals.
  checks.push({
    name: "no_unsupported_claim",
    passed: !hasUnsupportedNumericClaim(observation),
    detail: hasUnsupportedNumericClaim(observation)
      ? "근거 없이 수치를 서술함"
      : "근거 없는 수치 주장 없음"
  });

  const relevant = applicable(checks);
  const passed = relevant.every((check) => check.passed === true);
  const minutesSaved = Math.max(
    0,
    testCase.manualBaselineMinutes - elapsedMs / 60_000
  );

  return {
    id: testCase.id,
    intent: testCase.intent,
    passed,
    checks,
    elapsedMs,
    manualBaselineMinutes: testCase.manualBaselineMinutes,
    minutesSaved: passed ? minutesSaved : 0
  };
}

export interface BenchmarkReport {
  planner: string;
  totalCases: number;
  passedCases: number;
  passRate: number;
  /** Per-check pass rate across the cases where the check applied. */
  checkRates: Record<string, { passed: number; applicable: number; rate: number }>;
  medianElapsedMs: number;
  p95ElapsedMs: number;
  totalManualBaselineMinutes: number;
  totalMinutesSaved: number;
  results: BenchmarkCaseResult[];
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank, so a small suite never reports an interpolated latency that
  // no request actually experienced.
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1)
  );
  return sorted[rank]!;
}

export function summarizeBenchmark(
  planner: string,
  results: BenchmarkCaseResult[]
): BenchmarkReport {
  const checkRates: BenchmarkReport["checkRates"] = {};
  for (const result of results) {
    for (const check of result.checks) {
      if (check.passed === null) continue;
      const entry = (checkRates[check.name] ??= { passed: 0, applicable: 0, rate: 0 });
      entry.applicable += 1;
      if (check.passed) entry.passed += 1;
    }
  }
  for (const entry of Object.values(checkRates)) {
    entry.rate = entry.applicable === 0 ? 0 : entry.passed / entry.applicable;
  }
  const elapsed = results.map((result) => result.elapsedMs);
  const passedCases = results.filter((result) => result.passed).length;
  return {
    planner,
    totalCases: results.length,
    passedCases,
    passRate: results.length === 0 ? 0 : passedCases / results.length,
    checkRates,
    medianElapsedMs: percentile(elapsed, 0.5),
    p95ElapsedMs: percentile(elapsed, 0.95),
    totalManualBaselineMinutes: results.reduce(
      (sum, result) => sum + result.manualBaselineMinutes,
      0
    ),
    totalMinutesSaved: results.reduce((sum, result) => sum + result.minutesSaved, 0),
    results
  };
}

export function parseBenchmarkCases(jsonl: string): BenchmarkCase[] {
  return jsonl
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as BenchmarkCase);
}
