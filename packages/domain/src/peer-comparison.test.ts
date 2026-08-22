import { describe, expect, it } from "vitest";
import { comparePeerRegions } from "./analytics.js";
import type { ComparableTrendPoint } from "./types.js";

const basis = (overrides: Partial<ComparableTrendPoint["compatibility"]> = {}) => ({
  dataStatus: "official_observed" as const,
  populationMeasurementBasis: null,
  referenceDatePrecision: null,
  accountingBasis: "결산" as const,
  amountSemantics: "collected" as const,
  sourceGrain: "region_year" as const,
  unitOriginal: "원",
  unitMultiplier: 1,
  ...overrides
});

const series = (
  years: number[],
  values: number[],
  overrides: Partial<ComparableTrendPoint["compatibility"]> = {}
): ComparableTrendPoint[] =>
  years.map((year, index) => ({
    year,
    value: values[index]!,
    sourceId: `src-${year}`,
    compatibility: basis(overrides)
  }));

const compare = (input: Array<{ region: string; points: ComparableTrendPoint[] }>) =>
  comparePeerRegions({ metric: "local_tax_revenue", unit: "원", series: input });

describe("peer region comparison", () => {
  it("ranks only the years every included region observed", () => {
    const result = compare([
      { region: "A", points: series([2020, 2021, 2022], [10, 20, 30]) },
      { region: "B", points: series([2021, 2022, 2023], [50, 40, 90]) }
    ]);
    expect(result.commonYears).toEqual([2021, 2022]);
    expect(result.levelRanking.map((entry) => entry.region)).toEqual(["B", "A"]);
    expect(result.levelRanking[0]!.year).toBe(2022);
  });

  it("excludes a region recorded on a different accounting basis rather than ranking it", () => {
    const result = compare([
      { region: "A", points: series([2020, 2021], [10, 20]) },
      { region: "B", points: series([2020, 2021], [11, 21]) },
      {
        region: "C",
        points: series([2020, 2021], [900, 950], { accountingBasis: "예산" })
      }
    ]);
    expect(result.included.map((entry) => entry.region)).toEqual(["A", "B"]);
    expect(result.excluded).toContainEqual(
      expect.objectContaining({ region: "C", reason: "incompatible_with_peers" })
    );
    expect(result.levelRanking.some((entry) => entry.region === "C")).toBe(false);
  });

  it("uses only the compatible part of a series that changes unit midway", () => {
    const result = compare([
      { region: "A", points: series([2020, 2021], [10, 20]) },
      { region: "B", points: series([2020, 2021], [11, 21]) },
      {
        region: "C",
        points: [
          ...series([2020, 2021], [12, 22]),
          ...series([2022], [30], { unitOriginal: "천원", unitMultiplier: 1000 })
        ]
      }
    ]);
    expect(result.commonYears).toEqual([2020, 2021]);
    expect(result.included.map((entry) => entry.region).sort()).toEqual([
      "A",
      "B",
      "C"
    ]);
    expect(result.included.find((entry) => entry.region === "C")!.years).toEqual([
      2020, 2021
    ]);
  });

  it("keeps the basis the group shares rather than the one a single region uses", () => {
    const result = compare([
      { region: "A", points: series([2020, 2021], [10, 20]) },
      { region: "B", points: series([2020, 2021], [11, 21]) },
      {
        region: "C",
        points: series([2020, 2021], [900, 950], { accountingBasis: "예산" })
      }
    ]);
    expect(result.comparabilityBasis!.accountingBasis).toBe("결산");
    expect(result.excluded).toContainEqual(
      expect.objectContaining({ region: "C", reason: "incompatible_with_peers" })
    );
  });

  it("refuses to compare when no year is shared", () => {
    const result = compare([
      { region: "A", points: series([2018, 2019], [10, 20]) },
      { region: "B", points: series([2022, 2023], [30, 40]) }
    ]);
    expect(result.levelRanking).toEqual([]);
    expect(result.comparabilityRefusalReason).toContain(
      "공통으로 관측된 연도가 있는 조합이 없습니다"
    );
  });

  it("reports a region with no observations instead of dropping it silently", () => {
    const result = compare([
      { region: "A", points: series([2020, 2021], [10, 20]) },
      { region: "B", points: series([2020, 2021], [11, 21]) },
      { region: "C", points: [] }
    ]);
    expect(result.excluded).toContainEqual(
      expect.objectContaining({ region: "C", reason: "no_observations" })
    );
  });

  it("withholds a change ranking when only one year is shared", () => {
    const result = compare([
      { region: "A", points: series([2020, 2021], [10, 20]) },
      { region: "B", points: series([2021, 2022], [30, 40]) }
    ]);
    expect(result.commonYears).toEqual([2021]);
    expect(result.changeRanking).toBeNull();
    expect(result.changeRankingUnavailableReason).toBe("insufficient_common_years");
  });

  it("orders the change ranking by steepest decline first", () => {
    const result = compare([
      { region: "A", points: series([2020, 2021], [100, 50]) },
      { region: "B", points: series([2020, 2021], [100, 120]) }
    ]);
    expect(result.changeRanking!.map((entry) => entry.region)).toEqual(["A", "B"]);
  });

  it("refuses when fewer than two regions can be compared", () => {
    const result = compare([
      { region: "A", points: series([2020, 2021], [10, 20]) },
      { region: "B", points: [] }
    ]);
    expect(result.comparabilityRefusalReason).toContain("2개 미만");
  });
});

describe("peer comparison basis selection", () => {
  const basisSeries = (
    years: number[],
    values: number[],
    overrides: Partial<ComparableTrendPoint["compatibility"]> = {}
  ) => series(years, values, overrides);

  it("prefers a longer shared window over a wider group with one shared year", () => {
    const snapshot = { accountingBasis: "예산" as const };
    const result = comparePeerRegions({
      metric: "population",
      unit: "명",
      series: [
        {
          region: "A",
          points: [
            ...basisSeries([2018, 2019, 2020, 2021], [10, 11, 12, 13]),
            ...basisSeries([2025], [20], snapshot)
          ]
        },
        {
          region: "B",
          points: [
            ...basisSeries([2018, 2019, 2020, 2021], [30, 31, 32, 33]),
            ...basisSeries([2025], [40], snapshot)
          ]
        },
        { region: "C", points: basisSeries([2025], [50], snapshot) },
        { region: "D", points: basisSeries([2025], [60], snapshot) }
      ]
    });
    expect(result.commonYears).toEqual([2018, 2019, 2020, 2021]);
    expect(result.included.map((entry) => entry.region)).toEqual(["A", "B"]);
    expect(result.changeRanking).not.toBeNull();
    expect(result.excluded.map((entry) => entry.region)).toEqual(["C", "D"]);
  });
});
