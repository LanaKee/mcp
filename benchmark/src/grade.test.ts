import { describe, expect, it } from "vitest";
import { gradeResponse, summarizeArm } from "./grade.js";
import type { ArmResponse, BenchmarkCase, ResolvedGroundTruth } from "./types.js";

const numericCase: BenchmarkCase = {
  id: "pop-case",
  category: "recency",
  question: "2026년 김천시 인구는?",
  rationale: "test",
  groundTruth: { kind: "population_year", region: "김천시", year: 2026 },
  expect: { type: "numeric", tolerancePercent: 2, unit: "명" },
  requireCitation: true,
  manualBaselineMinutes: 12
};

const absentCase: BenchmarkCase = {
  id: "absent-case",
  category: "abstention",
  question: "2015년 울진군 인구는?",
  rationale: "test",
  groundTruth: { kind: "population_year", region: "울진군", year: 2015 },
  expect: { type: "absent" },
  requireCitation: false,
  manualBaselineMinutes: 10
};

const availableTruth: ResolvedGroundTruth = {
  available: true,
  value: 132_550,
  range: { min: 132_550, max: 132_550 },
  observations: 1,
  sourceIds: ["11111111-1111-4111-8111-111111111111"],
  note: "test"
};

const missingTruth: ResolvedGroundTruth = {
  available: false,
  value: null,
  range: null,
  observations: 0,
  sourceIds: [],
  note: "no rows"
};

function response(overrides: Partial<ArmResponse> = {}): ArmResponse {
  return {
    arm: "vanilla",
    text: "",
    transcript: "",
    citedSourceIds: [],
    citedAttributions: [],
    declined: null,
    latencyMs: 100,
    error: null,
    ...overrides
  };
}

describe("gradeResponse on a numeric case", () => {
  it("marks a figure inside tolerance correct", () => {
    const score = gradeResponse({
      benchmarkCase: numericCase,
      truth: availableTruth,
      response: response({ text: "2026년 김천시 인구는 132,550명입니다." }),
      verifiedSourceIds: new Set()
    });
    expect(score.correct).toBe(true);
    expect(score.hallucinated).toBe(false);
    expect(score.matchedValue).toBe(132_550);
  });

  it("counts a confidently wrong figure as a hallucination", () => {
    const score = gradeResponse({
      benchmarkCase: numericCase,
      truth: availableTruth,
      response: response({ text: "약 14만 3천 명입니다." }),
      verifiedSourceIds: new Set()
    });
    expect(score.correct).toBe(false);
    expect(score.hallucinated).toBe(true);
  });

  it("treats a refusal as incorrect but not a hallucination", () => {
    // The distinction is the point of the benchmark: silence is a failure to
    // help, whereas a wrong figure is a failure to be trustworthy.
    const score = gradeResponse({
      benchmarkCase: numericCase,
      truth: availableTruth,
      response: response({ text: "해당 수치는 확인할 수 없습니다." }),
      verifiedSourceIds: new Set()
    });
    expect(score.committed).toBe(false);
    expect(score.correct).toBe(false);
    expect(score.hallucinated).toBe(false);
  });

  it("does not score a transport failure as a refusal", () => {
    const score = gradeResponse({
      benchmarkCase: numericCase,
      truth: availableTruth,
      response: response({ error: "429 rate limited" }),
      verifiedSourceIds: new Set()
    });
    expect(score.hallucinated).toBe(false);
    expect(score.notes[0]).toContain("호출 실패");
  });

  it("honours the structural refusal signal", () => {
    const score = gradeResponse({
      benchmarkCase: numericCase,
      truth: availableTruth,
      response: response({ arm: "mcp", text: "근거 자료를 찾지 못했습니다.", declined: true }),
      verifiedSourceIds: new Set()
    });
    expect(score.committed).toBe(false);
    expect(score.hallucinated).toBe(false);
  });
});

describe("gradeResponse on an abstention case", () => {
  it("rewards declining when the corpus has no answer", () => {
    const score = gradeResponse({
      benchmarkCase: absentCase,
      truth: missingTruth,
      response: response({ text: "보유 자료에 해당 연도 관측치가 없어 확인할 수 없습니다." }),
      verifiedSourceIds: new Set()
    });
    expect(score.correct).toBe(true);
    expect(score.hallucinated).toBe(false);
  });

  it("penalises inventing a figure the corpus does not hold", () => {
    const score = gradeResponse({
      benchmarkCase: absentCase,
      truth: missingTruth,
      response: response({ text: "2015년 울진군 인구는 약 5만 1천 명입니다." }),
      verifiedSourceIds: new Set()
    });
    expect(score.correct).toBe(false);
    expect(score.hallucinated).toBe(true);
  });

  it("counts a hedged figure as an assertion, not a refusal", () => {
    // A real run scored "약 4만 5천 명 정도였던 것으로 추정됩니다. 정확한 수치는
    // 확인할 수 없습니다." as a correct abstention, crediting the arm for the
    // very fabrication this case exists to catch.
    const score = gradeResponse({
      benchmarkCase: absentCase,
      truth: missingTruth,
      response: response({
        text: "2015년 울진군 인구는 약 4만 5천 명 정도였던 것으로 추정됩니다. 정확한 수치는 확인할 수 없습니다."
      }),
      verifiedSourceIds: new Set()
    });
    expect(score.committed).toBe(true);
    expect(score.correct).toBe(false);
    expect(score.hallucinated).toBe(true);
  });

  it("still treats a bare refusal as declining", () => {
    const score = gradeResponse({
      benchmarkCase: absentCase,
      truth: missingTruth,
      response: response({ text: "해당 연도의 자료가 없어 확인할 수 없습니다." }),
      verifiedSourceIds: new Set()
    });
    expect(score.committed).toBe(false);
    expect(score.correct).toBe(true);
  });

  it("flags a case whose premise no longer holds", () => {
    const score = gradeResponse({
      benchmarkCase: absentCase,
      truth: availableTruth,
      response: response({ text: "확인할 수 없습니다." }),
      verifiedSourceIds: new Set()
    });
    expect(score.notes.some((note) => note.startsWith("경고"))).toBe(true);
  });
});

describe("provenance text must not reach the grader", () => {
  it("ignores digits inside a source key held in the transcript", () => {
    // A real run once scored a correct answer because the hex run "…fecc509152…"
    // inside a source key landed within 5% of a population of 499,352. Grading
    // the answer prose alone is what prevents that.
    const score = gradeResponse({
      benchmarkCase: {
        ...numericCase,
        expect: { type: "numeric", tolerancePercent: 5, unit: "명" }
      },
      truth: { ...availableTruth, value: 499_352, range: { min: 499_352, max: 500_002 } },
      response: response({
        arm: "mcp",
        text: "확인할 수 없습니다.",
        transcript:
          "source_id=official:88dca9d5fecc509152aeb45fbce53acef92f130422238d76be9948fe7523b736"
      }),
      verifiedSourceIds: new Set()
    });
    expect(score.correct).toBe(false);
    expect(score.extractedValues).toEqual([]);
  });
});

describe("citation accounting", () => {  it("counts only ids that resolve to a real source row", () => {
    const real = "11111111-1111-4111-8111-111111111111";
    const score = gradeResponse({
      benchmarkCase: numericCase,
      truth: availableTruth,
      response: response({
        arm: "mcp",
        text: "132,550명입니다.",
        citedSourceIds: [real, "22222222-2222-4222-8222-222222222222"],
        citedAttributions: ["행정안전부"]
      }),
      verifiedSourceIds: new Set([real])
    });
    expect(score.citationsClaimed).toBe(3);
    expect(score.citationsVerifiable).toBe(1);
  });
});

describe("summarizeArm", () => {
  const cases = [numericCase, absentCase];

  it("separates accuracy from hallucination rate", () => {
    const scores = [
      gradeResponse({
        benchmarkCase: numericCase,
        truth: availableTruth,
        response: response({ text: "확인할 수 없습니다." }),
        verifiedSourceIds: new Set()
      }),
      gradeResponse({
        benchmarkCase: absentCase,
        truth: missingTruth,
        response: response({ text: "약 5만 명입니다." }),
        verifiedSourceIds: new Set()
      })
    ];
    const summary = summarizeArm("vanilla", scores, cases);
    expect(summary.accuracy).toBe(0);
    expect(summary.hallucinationRate).toBe(0.5);
    expect(summary.abstentionAccuracy).toBe(0);
  });

  it("reports hallucination per answer given, not just per case", () => {
    // An arm that declines most questions posts a flattering per-case rate. The
    // per-answer rate is what makes two arms with different answer rates
    // comparable, so both are published.
    const scores = [
      gradeResponse({
        benchmarkCase: numericCase,
        truth: availableTruth,
        response: response({ text: "확인할 수 없습니다." }),
        verifiedSourceIds: new Set()
      }),
      gradeResponse({
        benchmarkCase: absentCase,
        truth: missingTruth,
        response: response({ text: "약 5만 명입니다." }),
        verifiedSourceIds: new Set()
      })
    ];
    const summary = summarizeArm("vanilla", scores, cases);
    expect(summary.commitmentRate).toBe(0.5);
    expect(summary.hallucinationPerCommitted).toBe(1);
  });

  it("reports zero rather than dividing by zero when nothing was cited", () => {
    const scores = [
      gradeResponse({
        benchmarkCase: numericCase,
        truth: availableTruth,
        response: response({ text: "132,550명" }),
        verifiedSourceIds: new Set()
      })
    ];
    expect(summarizeArm("vanilla", scores, cases).citationVerifiability).toBe(0);
  });
});
