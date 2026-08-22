import { describe, expect, it } from "vitest";
import {
  analyzeComparableTrend,
  comparePopulationAndTax,
  evaluatePolicyEligibility,
  localTaxTrendPoints,
  normalizeRegionName,
  populationTrendPoints,
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

  it("requires at least two points for a trend", () => {
    expect(() =>
      summarizeTrend([{ year: 2024, value: 100, sourceId: "s" }])
    ).toThrow("두 건 이상");
  });

  it("returns a machine-readable reason for a single-point series", () => {
    const analysis = analyzeComparableTrend([
      {
        year: 2024,
        value: 100,
        sourceId: "official",
        compatibility: {
          dataStatus: "official_observed",
          accountingBasis: null,
          amountSemantics: null,
          sourceGrain: null,
          unitOriginal: null,
          unitMultiplier: null
        }
      }
    ]);
    expect(analysis).toMatchObject({
      summary: null,
      summaryUnavailableReason: "insufficient_points"
    });
  });

  it("does not fabricate a percentage change from a zero baseline", () => {
    expect(
      summarizeTrend([
        { year: 2023, value: 0, sourceId: "source-a" },
        { year: 2024, value: 100, sourceId: "source-a" }
      ])
    ).toMatchObject({
      absoluteChange: 100,
      changePercent: null,
      changePercentUnavailableReason: "zero_baseline",
      direction: "increase"
    });
  });

  it.each([
    {
      name: "mixed statuses",
      mutate: (row: LocalTaxRecord) => ({
        ...row,
        dataStatus: "demo_sample" as const
      })
    },
    {
      name: "different amount semantics",
      mutate: (row: LocalTaxRecord) => ({
        ...row,
        amountSemantics: "payment_amount" as const
      })
    },
    {
      name: "different accounting bases",
      mutate: (row: LocalTaxRecord) => ({
        ...row,
        accountingBasis: "reported" as const
      })
    },
    {
      name: "different source grains",
      mutate: (row: LocalTaxRecord) => ({
        ...row,
        sourceGrain: "per_capita_burden" as const
      })
    },
    {
      name: "different source units",
      mutate: (row: LocalTaxRecord) => ({
        ...row,
        unitOriginal: "thousand_KRW" as const,
        unitMultiplier: 1000 as const
      })
    }
  ])("does not summarize $name", ({ mutate }) => {
    const base: LocalTaxRecord = {
      regionId: "47150",
      regionName: "김천시",
      fiscalYear: 2023,
      taxCategory: "합계",
      revenueAmountWon: 100,
      accountingBasis: "settlement",
      amountSemantics: "collected_amount",
      sourceGrain: "collection_status",
      unitOriginal: "KRW",
      unitMultiplier: 1,
      sourceId: "official-a",
      dataStatus: "official_observed"
    };
    const analysis = analyzeComparableTrend(
      localTaxTrendPoints([
        base,
        mutate({
          ...base,
          fiscalYear: 2024,
          revenueAmountWon: 120,
          sourceId: "official-b"
        })
      ])
    );
    expect(analysis).toMatchObject({
      summary: null,
      summaryUnavailableReason: "incomparable_sources"
    });
  });

  it("summarizes a homogeneous official series", () => {
    const analysis = analyzeComparableTrend(
      localTaxTrendPoints(
        [2023, 2024].map((fiscalYear, index) => ({
          regionId: "47150",
          regionName: "김천시",
          fiscalYear,
          taxCategory: "합계",
          revenueAmountWon: 100 + index * 20,
          accountingBasis: "settlement" as const,
          amountSemantics: "collected_amount" as const,
          sourceGrain: "collection_status" as const,
          unitOriginal: "KRW" as const,
          unitMultiplier: 1 as const,
          sourceId: `official-${fiscalYear}`,
          dataStatus: "official_observed" as const
        }))
      )
    );
    expect(analysis).toMatchObject({
      summary: {
        absoluteChange: 20,
        changePercent: 20,
        direction: "increase"
      },
      summaryUnavailableReason: null
    });
  });

  it("does not derive a comparison verdict from demo data", () => {
    const populations: PopulationRecord[] = [2022, 2024].map((year, index) => ({
      regionId: "47110",
      regionName: "포항시",
      year,
      populationTotal: 500000 - index * 10000,
      measurementBasis: "demo_annual_population",
      referenceDatePrecision: "year",
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
    expect(comparePopulationAndTax(populations, taxes, 2022, 2024)[0]).toMatchObject({
      evaluable: false,
      matches: null,
      notEvaluableReason: "non_official_data",
      populationTrend: null,
      taxTrend: null,
      populationDataStatuses: ["demo_sample"],
      taxDataStatuses: ["demo_sample"]
    });
  });

  it("evaluates a homogeneous official population/tax comparison", () => {
    const populations: PopulationRecord[] = [2022, 2024].map((year, index) => ({
      regionId: "47110",
      regionName: "포항시",
      year,
      populationTotal: 500000 - index * 10000,
      measurementBasis: "resident_registration_snapshot",
      referenceDatePrecision: "month",
      sourceId: `p-${year}`,
      dataStatus: "official_observed"
    }));
    const taxes: LocalTaxRecord[] = [2022, 2024].map((fiscalYear, index) => ({
      regionId: "47110",
      regionName: "포항시",
      fiscalYear,
      taxCategory: "합계",
      revenueAmountWon: 800000000000 + index * 50000000000,
      accountingBasis: "settlement",
      amountSemantics: "collected_amount",
      sourceGrain: "collection_status",
      unitOriginal: "KRW",
      unitMultiplier: 1,
      sourceId: `t-${fiscalYear}`,
      dataStatus: "official_observed"
    }));
    expect(comparePopulationAndTax(populations, taxes, 2022, 2024)[0]).toMatchObject({
      evaluable: true,
      matches: true,
      notEvaluableReason: null
    });
  });

  it("rejects official population points with different measurement semantics", () => {
      const populations: PopulationRecord[] = [
        {
          regionId: "47820",
          regionName: "청도군",
          year: 2022,
          populationTotal: 41614,
          measurementBasis: "tax_year_reported_population",
          referenceDatePrecision: "year",
          sourceId: "tax-report",
          dataStatus: "official_observed"
        },
        {
          regionId: "47820",
          regionName: "청도군",
          year: 2025,
          populationTotal: 40778,
          measurementBasis: "resident_registration_snapshot",
          referenceDatePrecision: "day",
          sourceId: "snapshot",
          dataStatus: "official_observed"
        }
      ];
      expect(
        analyzeComparableTrend(populationTrendPoints(populations))
      ).toMatchObject({
        summary: null,
        summaryUnavailableReason: "incomparable_sources"
      });
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
