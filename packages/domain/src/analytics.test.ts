import { describe, expect, it } from "vitest";
import {
  comparePopulationAndTax,
  evaluatePolicyEligibility,
  normalizeRegionName,
  summarizeTrend
} from "./index.js";
import type { LocalTaxRecord, PolicyRecord, PopulationRecord } from "./index.js";

describe("domain analytics", () => {
  it("normalizes decomposed Hangul and province prefixes", () => {
    expect(normalizeRegionName("경상북도 포항시")).toBe("포항시");
  });

  it("calculates trend direction and percentage", () => {
    expect(
      summarizeTrend([
        { year: 2022, value: 100, sourceId: "s" },
        { year: 2024, value: 90, sourceId: "s" }
      ])
    ).toMatchObject({ absoluteChange: -10, changePercent: -10, direction: "decrease" });
  });

  it("finds a declining-population and rising-tax region", () => {
    const populations: PopulationRecord[] = [2022, 2024].map((year, index) => ({
      regionId: "47110",
      regionName: "포항시",
      year,
      populationTotal: 500000 - index * 10000,
      sourceId: "p",
      dataStatus: "demo_sample"
    }));
    const taxes: LocalTaxRecord[] = [2022, 2024].map((fiscalYear, index) => ({
      regionId: "47110",
      regionName: "포항시",
      fiscalYear,
      taxCategory: "합계",
      revenueAmountWon: 800000000000 + index * 50000000000,
      accountingBasis: "settlement",
      sourceId: "t",
      dataStatus: "demo_sample"
    }));
    expect(comparePopulationAndTax(populations, taxes, 2022, 2024)[0]?.matches).toBe(true);
  });

  it("explains age-34 smart farm eligibility", () => {
    const policy: PolicyRecord = {
      policyId: "policy-1",
      title: "청년 스마트팜 창업 지원",
      regionId: "47250",
      regionName: "상주시",
      ageMin: 18,
      ageMax: 39,
      industries: ["스마트팜", "농업"],
      stages: ["예비창업"],
      eligibilityText: "상주시 청년 예비창업자",
      support: "교육",
      applicationPeriod: "예시",
      sourceId: "policy-source",
      dataStatus: "demo_sample"
    };
    const result = evaluatePolicyEligibility(policy, {
      region: "경상북도 상주시",
      age: 34,
      query: "스마트팜",
      stage: "예비창업"
    });
    expect(result.eligible).toBe(true);
    expect(result.reasons).toHaveLength(4);
  });
});

