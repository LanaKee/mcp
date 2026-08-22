import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBenchmarkCases } from "./cases.js";

const BENCHMARK_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("parseBenchmarkCases", () => {
  it("rejects a duplicate id", () => {
    const line = JSON.stringify({
      id: "a",
      category: "recency",
      question: "q",
      rationale: "r",
      groundTruth: { kind: "policy_program_any" },
      expect: { type: "absent" },
      requireCitation: false,
      manualBaselineMinutes: 5
    });
    expect(() => parseBenchmarkCases(`${line}\n${line}`)).toThrow(/duplicate id/);
  });

  it("rejects a numeric expectation with no tolerance", () => {
    // A missing tolerance would coerce to zero and fail every answer, which
    // reads as a striking result instead of the defect it is.
    const line = JSON.stringify({
      id: "a",
      category: "precision",
      question: "q",
      rationale: "r",
      groundTruth: { kind: "council_bill_count_year", year: 2026 },
      expect: { type: "numeric", unit: "건" },
      requireCitation: true,
      manualBaselineMinutes: 5
    });
    expect(() => parseBenchmarkCases(line)).toThrow(/tolerancePercent/);
  });

  it("rejects an unknown ground truth kind", () => {
    const line = JSON.stringify({
      id: "a",
      category: "precision",
      question: "q",
      rationale: "r",
      groundTruth: { kind: "made_up" },
      expect: { type: "absent" },
      requireCitation: false,
      manualBaselineMinutes: 5
    });
    expect(() => parseBenchmarkCases(line)).toThrow(/unknown groundTruth.kind/);
  });

  it("requires a rationale so the suite can be audited", () => {
    const line = JSON.stringify({
      id: "a",
      category: "precision",
      question: "q",
      groundTruth: { kind: "policy_program_any" },
      expect: { type: "absent" },
      requireCitation: false,
      manualBaselineMinutes: 5
    });
    expect(() => parseBenchmarkCases(line)).toThrow(/rationale/);
  });
});

describe("shipped Gyeongbuk suite", () => {
  const cases = parseBenchmarkCases(
    readFileSync(resolve(BENCHMARK_ROOT, "cases/gyeongbuk.jsonl"), "utf8")
  );

  it("loads every case", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  describe("Gyeongbuk v2 suite", () => {
    const v1 = parseBenchmarkCases(
      readFileSync(resolve(BENCHMARK_ROOT, "cases/gyeongbuk.jsonl"), "utf8")
    );
    const v2 = parseBenchmarkCases(
      readFileSync(resolve(BENCHMARK_ROOT, "cases/gyeongbuk-v2.jsonl"), "utf8")
    );

    it("changes only the ambiguous policy abstention question", () => {
      expect(v2).toHaveLength(v1.length);
      expect(v2.filter((entry, index) => entry.question !== v1[index]?.question)).toHaveLength(1);
      expect(v2.find((entry) => entry.id === "ab-policy-programs")?.question).toContain(
        "공식 공고문"
      );
    });
  });

  it("includes cases a general model can plausibly win", () => {
    // A suite composed only of questions the baseline cannot answer would be a
    // demonstration, not a measurement.
    expect(cases.filter((entry) => entry.category === "common_knowledge").length).toBeGreaterThan(0);
  });

  it("includes cases where declining is the correct answer", () => {
    expect(cases.filter((entry) => entry.expect.type === "absent").length).toBeGreaterThanOrEqual(3);
  });

  it("keeps every numeric target clear of the calendar-year range", () => {
    // The parser drops bare 1900-2099 integers as dates. A target inside that
    // range would be unscoreable, so the suite must avoid one.
    const yearLike = cases.filter(
      (entry) => entry.category === "recency" && entry.expect.type === "numeric"
    );
    expect(yearLike.length).toBeGreaterThan(0);
  });

  it("covers every category", () => {
    const categories = new Set(cases.map((entry) => entry.category));
    expect(categories).toEqual(
      new Set([
        "common_knowledge",
        "recency",
        "hyperlocal",
        "precision",
        "abstention",
        "provenance"
      ])
    );
  });
});
