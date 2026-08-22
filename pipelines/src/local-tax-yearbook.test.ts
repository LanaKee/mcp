import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { emptyLocalTaxNormalization } from "./local-tax.js";
import {
  detectLocalTaxYearbookHwpx,
  localTaxYearbookFiscalYear,
  mergeLocalTaxNormalizations,
  normalizeLocalTaxYearbook
} from "./local-tax-yearbook.js";
import { GYEONGBUK_REGIONS } from "./regions.js";

const municipalities = GYEONGBUK_REGIONS.filter(
  (region) => region.regionType !== "province"
);

function row(cells: string[]): string {
  return `<hp:tr>${cells
    .map(
      (cell) =>
        `<hp:tc><hp:p><hp:run><hp:t>${cell}</hp:t></hp:run></hp:p></hp:tc>`
    )
    .join("")}</hp:tr>`;
}

function table(rows: string[][]): string {
  return `<hp:tbl>${rows.map(row).join("")}</hp:tbl>`;
}

function fixture(options: { mismatchRegion?: string } = {}): Uint8Array {
  const baseRows: string[][] = [
    ["1-16. 경상북도 Gyeongbuk"],
    ["자치단체별", "합계", "도세"],
    ["소계", "취득세"],
    ["합계 Total", "66", "22"],
    ["경상북도", "22", "22"]
  ];
  const cityRows: string[][] = [
    [""],
    ["시 세 City Tax"],
    ["소계", "지방소비세"],
    ["20", "20"],
    ["-", "-"]
  ];
  const countyRows: string[][] = [
    [""],
    ["자치단체별", "군 세"],
    ["소계", "지방소비세"],
    ["24", "24"],
    ["경상북도", "-", "-"]
  ];
  const countyContinuationRows: string[][] = [
    ["단위：천원 In Thousand Won"],
    ["County Tax"],
    ["자동차세"],
    ["-"],
    ["-"]
  ];

  for (const region of municipalities) {
    baseRows.push([region.regionName, "3", "1"]);
    if (region.regionType === "city") {
      cityRows.push([
        "2",
        options.mismatchRegion === region.regionName ? "1" : "2",
        "-",
        "-",
        "-",
        "-",
        "-",
        "-",
        "-",
        "-",
        "-"
      ]);
      countyRows.push([region.regionName, "-", "-", "-", "-", "-"]);
    } else {
      cityRows.push(["-", "-", "-", "-", "-", "-", "-", "-", "-", "-", "-"]);
      countyRows.push([
        region.regionName,
        "2",
        options.mismatchRegion === region.regionName ? "1" : "2",
        "-",
        "-",
        "-"
      ]);
    }
    countyContinuationRows.push(["-", "-", "-", "-", "-"]);
  }

  const section0 =
    "<hp:sec><hp:p><hp:run><hp:t>제4장 2024년도 시·도, 시·군·구별 부과·징수실적</hp:t></hp:run></hp:p></hp:sec>";
  const section34 = `<hp:sec>${[
    table(baseRows),
    table(cityRows),
    table(countyRows),
    table(countyContinuationRows)
  ].join("")}</hp:sec>`;
  return zipSync({
    mimetype: strToU8("application/hwp+zip"),
    "Contents/section0.xml": strToU8(section0),
    "Contents/section34.xml": strToU8(section34)
  });
}

describe("official local-tax statistical yearbook", () => {
  it("detects and normalizes all canonical municipalities from HWPX content", () => {
    const buffer = fixture();
    expect(detectLocalTaxYearbookHwpx(buffer)).toBe(true);
    expect(localTaxYearbookFiscalYear(buffer)).toBe(2024);

    const result = normalizeLocalTaxYearbook({
      path: "datasets/new/yearbook.hwpx",
      sha256: "a".repeat(64),
      buffer
    });
    expect(result.headlineRevenue).toHaveLength(municipalities.length * 2);
    expect(
      new Set(result.headlineRevenue.map((row) => row.regionId)).size
    ).toBe(municipalities.length);
    expect(result.headlineRevenue[0]).toMatchObject({
      fiscalYear: 2024,
      revenueAmountWon: 2000,
      sourceGrain: "statistical_yearbook_local_collection",
      unitOriginal: "thousand_KRW",
      unitMultiplier: 1000
    });
    expect(result.qualityIssues).toEqual([
      expect.objectContaining({
        severity: "info",
        issueCode: "yearbook_full_gyeongbuk_coverage"
      })
    ]);
  });

  it("quarantines a region when local subtotal and details do not reconcile", () => {
    const result = normalizeLocalTaxYearbook({
      path: "datasets/new/yearbook.hwpx",
      sha256: "b".repeat(64),
      buffer: fixture({ mismatchRegion: "포항시" })
    });
    expect(result.qualityIssues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        issueCode: "yearbook_local_tax_reconciliation_failed",
        quarantined: true
      })
    );
    expect(
      result.headlineRevenue.some((row) => row.regionName === "포항시")
    ).toBe(false);
  });

  it("uses the yearbook local subtotal when a municipal CSV aggregate has combined scope", () => {
    const yearbook = normalizeLocalTaxYearbook({
      path: "datasets/new/yearbook.hwpx",
      sha256: "c".repeat(64),
      buffer: fixture()
    });
    const csv = emptyLocalTaxNormalization();
    const county = yearbook.headlineRevenue.find(
      (row) => row.regionName === "의성군" && row.taxCategory === "합계"
    )!;
    csv.headlineRevenue.push({
      ...county,
      revenueAmountWon: 3000,
      sourcePath: "datasets/new/uiseong.csv",
      sourceSha256: "d".repeat(64),
      sourceGrain: "collection_status"
    });

    const merged = mergeLocalTaxNormalizations([csv, yearbook]);
    const aggregateRows = merged.headlineRevenue.filter(
      (row) => row.regionName === "의성군" && row.taxCategory === "합계"
    );
    expect(aggregateRows).toHaveLength(2);
    expect(
      aggregateRows.find((row) => row.sourceGrain === "collection_status")
        ?.metadata
    ).toMatchObject({
      headlineEligible: false,
      collectionScope: "combined_province_and_local_tax"
    });
    expect(merged.qualityIssues).toContainEqual(
      expect.objectContaining({
        severity: "info",
        issueCode: "combined_scope_aggregate_excluded_from_headline"
      })
    );
  });
});
