import { describe, expect, it } from "vitest";
import {
  errorRateOf,
  MAX_TOLERATED_ERROR_RATE,
  renderComparison,
  toRow
} from "./compare-models.js";
import type { ArmSummary, BenchmarkReport, RecordedResponse } from "./types.js";

function summary(arm: "vanilla" | "mcp", overrides: Partial<ArmSummary> = {}): ArmSummary {
  return {
    arm,
    cases: 22,
    correct: 11,
    accuracy: 0.5,
    commitmentRate: 0.5,
    hallucinationRate: 0.1,
    hallucinationPerCommitted: 0.2,
    abstentionAccuracy: 0.5,
    citationVerifiability: 0,
    medianLatencyMs: 500,
    errors: 0,
    ...overrides
  };
}

function response(overrides: Partial<RecordedResponse> = {}): RecordedResponse {
  return {
    caseId: "c1",
    arm: "vanilla",
    text: "답",
    transcript: "답",
    citedSourceIds: [],
    citedAttributions: [],
    declined: null,
    latencyMs: 100,
    ...overrides
  } as RecordedResponse;
}

function report(overrides: Partial<BenchmarkReport> = {}): BenchmarkReport {
  return {
    generatedAt: "2026-08-23T00:00:00.000Z",
    model: "test-model",
    provider: "openai",
    temperaturePinned: true,
    mode: "live",
    cases: 22,
    arms: [summary("vanilla"), summary("mcp", { accuracy: 0.8 })],
    byCategory: [],
    scores: [],
    groundTruth: [],
    responses: [response()],
    minutesSavedOnCorrect: 0,
    ...overrides
  } as BenchmarkReport;
}

describe("run validity", () => {
  it("measures the share of calls that never reached the model", () => {
    const rate = errorRateOf(
      report({
        responses: [
          response(),
          response({ error: "429 Too Many Requests" }),
          response({ error: "429 Too Many Requests" }),
          response()
        ]
      })
    );
    expect(rate).toBe(0.5);
  });

  it("rejects a run that mostly failed to reach the model", () => {
    // A rate-limited run measures the account's quota, not the model. Scoring
    // it as a model result was a real error made against gemini-3.6-flash.
    const row = toRow(
      report({
        responses: [response({ error: "429" }), response({ error: "429" }), response()]
      })
    );
    expect(row.valid).toBe(false);
    expect(row.errorRate).toBeGreaterThan(MAX_TOLERATED_ERROR_RATE);
  });

  it("accepts a run with only incidental failures", () => {
    const responses = Array.from({ length: 44 }, (_, index) =>
      index === 0 ? response({ error: "aborted" }) : response()
    );
    expect(toRow(report({ responses })).valid).toBe(true);
  });

  it("treats an empty run as error-free rather than dividing by zero", () => {
    expect(errorRateOf(report({ responses: [] }))).toBe(0);
  });
});

describe("comparison rendering", () => {
  it("keeps an invalid run out of the score tables but names it in the record", () => {
    const rows = [
      toRow(report({ model: "good-model" })),
      toRow(
        report({
          model: "throttled-model",
          responses: [response({ error: "429" }), response({ error: "429" })]
        })
      )
    ];
    const markdown = renderComparison(rows);
    const accuracySection = markdown.slice(
      markdown.indexOf("## 정확도"),
      markdown.indexOf("## 환각")
    );
    expect(accuracySection).toContain("good-model");
    // Silently dropping it would hide that the run was ever attempted.
    expect(accuracySection).not.toContain("throttled-model");
    expect(markdown).toContain("무효");
    expect(markdown.slice(markdown.indexOf("## 실행 조건"))).toContain("throttled-model");
  });

  it("reports the within-model gap, which is the quantity under test", () => {
    const markdown = renderComparison([
      toRow(
        report({
          arms: [summary("vanilla", { accuracy: 0.2 }), summary("mcp", { accuracy: 0.75 })]
        })
      )
    ]);
    expect(markdown).toContain("+55.0p");
  });

  it("records that a model refused to pin temperature", () => {
    const markdown = renderComparison([toRow(report({ temperaturePinned: false }))]);
    expect(markdown).toContain("거부");
  });

  it("counts how many models the grounded arm actually helped", () => {
    const markdown = renderComparison([
      toRow(
        report({
          model: "a",
          arms: [summary("vanilla", { accuracy: 0.2 }), summary("mcp", { accuracy: 0.7 })]
        })
      ),
      toRow(
        report({
          model: "b",
          arms: [summary("vanilla", { accuracy: 0.6 }), summary("mcp", { accuracy: 0.5 })]
        })
      )
    ]);
    expect(markdown).toContain("2개 중 1개");
    // Latency claims must be derived from the run, not asserted in prose.
    expect(markdown).toContain("지연");
  });
});
