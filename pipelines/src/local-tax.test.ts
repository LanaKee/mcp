import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import { parseKoreanCsv } from "./csv.js";
import {
  detectLocalTaxCsvKind,
  normalizeLocalTaxSources,
  parseTaxYear,
  resolveTaxRegionIdentity,
  type LocalTaxCsvKind,
  type LocalTaxSourceInput
} from "./local-tax.js";
import { populationRowsFromTaxPerCapita } from "./population.js";

const sha256 = "a".repeat(64);

function source(
  kind: LocalTaxCsvKind,
  headers: string[],
  rows: Record<string, string>[],
  path = `datasets/new/${kind}.csv`
): LocalTaxSourceInput {
  return { kind, headers, rows, path, sha256 };
}

describe("official local-tax normalization", () => {
  it("detects tax shapes from decoded content rather than filenames", () => {
    const csv = parseKoreanCsv(
      iconv.encode(
        "시군구명,자치단체코드,과세년도,세목명,부과금액(천원),수납급액(천원),환급금액(천원),결손금액(천원),미수납 금액(천원),징수율\n김천시,47150,2024,합계,1,1,0,0,0,100\n",
        "cp949"
      )
    );
    expect(csv.encoding).toBe("cp949");
    expect(detectLocalTaxCsvKind(csv.headers)).toBe("local_tax_collection");
    expect(
      detectLocalTaxCsvKind(["법정동", "물건지", "시가표준액"])
    ).toBe("property_valuation_microdata");
    expect(
      detectLocalTaxCsvKind(["연도", "구분", "세액", "건수", "법령"])
    ).toBe("local_tax_exemption_unverified");
    expect(
      [
        [["세목명", "납부건수", "납부금액"], "local_tax_payment_media"],
        [
          ["세목명", "과세건수", "과세금액", "비과세건수", "비과세금액"],
          "local_tax_assessment"
        ],
        [
          ["과세년도", "주민1인당 부담금액", "세대당부담금액", "지방세 금액"],
          "local_tax_per_capita"
        ],
        [
          ["과세년도", "세목명", "납세자유형", "납세자수"],
          "local_tax_taxpayer"
        ],
        [
          ["세목명", "비과세금액(원)", "감면금액(원)", "부과금액(원)"],
          "local_tax_exemption"
        ],
        [
          ["세목명", "과세년도", "미환급유형", "당해미환급건수", "누적미환급금액"],
          "local_tax_unrefunded"
        ],
        [
          ["영치일", "영치기관", "체납건수", "체납액"],
          "local_tax_enforcement"
        ]
      ].map(([headers, expected]) => [
        detectLocalTaxCsvKind(headers as string[]),
        expected
      ])
    ).toEqual([
      ["local_tax_payment_media", "local_tax_payment_media"],
      ["local_tax_assessment", "local_tax_assessment"],
      ["local_tax_per_capita", "local_tax_per_capita"],
      ["local_tax_taxpayer", "local_tax_taxpayer"],
      ["local_tax_exemption", "local_tax_exemption"],
      ["local_tax_unrefunded", "local_tax_unrefunded"],
      ["local_tax_enforcement", "local_tax_enforcement"]
    ]);
  });

  it("normalizes every verified fact grain and preserves nullable blanks", () => {
    const result = normalizeLocalTaxSources([
      source(
        "local_tax_collection",
        [
          "시군구명",
          "자치단체코드",
          "과세년도",
          "세목명",
          "부과금액(천원)",
          "수납급액(천원)",
          "환급금액(천원)",
          "결손금액(천원)",
          "미수납 금액(천원)",
          "징수율"
        ],
        [
          {
            시군구명: "김천시",
            자치단체코드: "47150",
            과세년도: "2024",
            세목명: "합계",
            "부과금액(천원)": "10",
            "수납급액(천원)": "9",
            "환급금액(천원)": "",
            "결손금액(천원)": "",
            "미수납 금액(천원)": "1",
            징수율: "90"
          }
        ]
      ),
      source(
        "local_tax_payment_media",
        ["시군구명", "자치단체코드", "납부년도", "세목명", "납부매체", "납부건수", "납부금액"],
        [{
          시군구명: "구미시",
          자치단체코드: "47190",
          납부년도: "2024",
          세목명: "주민세",
          납부매체: "인터넷",
          납부건수: "2",
          납부금액: "3000"
        }]
      ),
      source(
        "local_tax_assessment",
        ["시군구명", "자치단체코드", "과세년도", "세목명", "과세건수", "과세금액", "비과세건수", "비과세금액"],
        [{
          시군구명: "경산시",
          자치단체코드: "47290",
          과세년도: "2024",
          세목명: "재산세",
          과세건수: "5",
          과세금액: "8000",
          비과세건수: "",
          비과세금액: ""
        }]
      ),
      source(
        "local_tax_per_capita",
        ["시군구명", "자치단체코드", "과세년도", "주민1인당 부담금액", "세대당부담금액", "지방세 금액", "인구수", "세대수"],
        [{
          시군구명: "봉화군",
          자치단체코드: "47920",
          과세년도: "2024",
          "주민1인당 부담금액": "1152975.163",
          세대당부담금액: "2002842.879",
          "지방세 금액": "33247191790",
          인구수: "28836",
          세대수: "16600"
        }]
      ),
      source(
        "local_tax_taxpayer",
        ["시군구명", "자치단체코드", "과세년도", "세목명", "납세자유형", "관내_관외", "납세자수"],
        [{
          시군구명: "울진군",
          자치단체코드: "47930",
          과세년도: "2024",
          세목명: "자동차세",
          납세자유형: "개인",
          관내_관외: "관내",
          납세자수: "20"
        }]
      ),
      source(
        "local_tax_exemption",
        ["시군구명", "자치단체코드", "세목명", "과세년도", "비과세금액(원)", "감면금액(원)", "부과금액(원)", "비과세감면율(퍼센트)"],
        [{
          시군구명: "예천군",
          자치단체코드: "47900",
          세목명: "취득세",
          과세년도: "14",
          "비과세금액(원)": "100",
          "감면금액(원)": "50",
          "부과금액(원)": "1000",
          "비과세감면율(퍼센트)": "15"
        }]
      ),
      source(
        "local_tax_unrefunded",
        ["시군구명", "자치단체코드", "세목명", "과세년도", "미환급유형", "납세자유형", "당해미환급건수", "당해미환급금액", "누적미환급건수", "누적미환급금액"],
        [{
          시군구명: "봉화군",
          자치단체코드: "47920",
          세목명: "지방소득세",
          과세년도: "2024",
          미환급유형: "과오납",
          납세자유형: "개인",
          당해미환급건수: "1",
          당해미환급금액: "200",
          누적미환급건수: "2",
          누적미환급금액: "400"
        }]
      ),
      source(
        "local_tax_enforcement",
        ["영치일", "영치기관", "영치장소", "체납건수", "체납액"],
        [{
          영치일: "2024-04-01",
          영치기관: "문경시",
          영치장소: "상세 위치",
          체납건수: "3",
          체납액: "600"
        }],
        "datasets/new/문경시_번호판 영치내역.csv"
      )
    ]);

    expect(result.collection[0]).toMatchObject({
      regionId: "47150",
      collectedAmountWon: 9000,
      refundedAmountWon: null,
      writtenOffAmountWon: null,
      unitMultiplier: 1000,
      isAggregate: true
    });
    expect(result.assessment[0]).toMatchObject({
      nonTaxableCount: null,
      nonTaxableAmountWon: null
    });
    expect(result.exemption[0]?.fiscalYear).toBe(2014);
    expect(result.paymentMedia).toHaveLength(1);
    expect(result.perCapita).toHaveLength(1);
    expect(result.perCapita[0]).toMatchObject({
      perResidentAmountWon: 1152975,
      perHouseholdAmountWon: 2002843,
      totalLocalTaxAmountWon: 33247191790
    });
    expect(
      result.qualityIssues.filter(
        (item) => item.issueCode === "fractional_won_rounded"
      )
    ).toHaveLength(2);
    expect(populationRowsFromTaxPerCapita(result.perCapita)).toMatchObject([
      {
        regionName: "봉화군",
        referenceDate: "2024-12-31",
        populationTotal: 28836,
        householdCount: 16600,
        measurementBasis: "tax_year_reported_population",
        referenceDatePrecision: "year",
        metadata: {
          referenceDateRole: "canonical_tax_year_period_end"
        }
      }
    ]);
    expect(result.taxpayer).toHaveLength(1);
    expect(result.unrefunded).toHaveLength(1);
    expect(result.enforcement[0]).not.toHaveProperty("location");
    expect(result.qualityIssues.some((item) => item.severity === "error")).toBe(false);
  });

  it("infers an unmarked thousand-KRW payment unit only from exact reconciliation", () => {
    const categories = ["주민세", "재산세", "자동차세"];
    const collection = source(
      "local_tax_collection",
      ["시군구명", "자치단체코드", "과세년도", "세목명", "부과금액(천원)", "수납급액(천원)", "환급금액(천원)", "결손금액(천원)", "미수납 금액(천원)"],
      categories.map((taxCategory, index) => ({
        시군구명: "김천시",
        자치단체코드: "47150",
        과세년도: "2024",
        세목명: taxCategory,
        "부과금액(천원)": String(index + 2),
        "수납급액(천원)": String(index + 1),
        "환급금액(천원)": "0",
        "결손금액(천원)": "0",
        "미수납 금액(천원)": "1"
      })),
      "datasets/new/kimcheon-collection.csv"
    );
    const payment = source(
      "local_tax_payment_media",
      ["시군구명", "자치단체코드", "납부년도", "세목명", "납부건수", "납부금액"],
      categories.map((taxCategory, index) => ({
        시군구명: "김천시",
        자치단체코드: "47150",
        납부년도: "2024",
        세목명: taxCategory,
        납부건수: "1",
        납부금액: String(index + 1)
      })),
      "datasets/new/kimcheon-payment.csv"
    );

    const result = normalizeLocalTaxSources([payment, collection]);
    expect(result.paymentMedia.map((row) => row.paymentAmountWon)).toEqual([
      1000,
      2000,
      3000
    ]);
    expect(result.paymentMedia.every((row) => row.unitMultiplier === 1000)).toBe(true);
    expect(result.reconciliations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reconciliationCode: "payment_vs_collection_unit_evidence",
          status: "passed"
        })
      ])
    );
  });

  it("quarantines unverified semantics and excludes address-level microdata", () => {
    const result = normalizeLocalTaxSources([
      source(
        "local_tax_exemption_unverified",
        ["연도", "구분", "세액", "건수", "법령"],
        [{ 연도: "2024", 구분: "감면", 세액: "548", 건수: "6969586", 법령: "조례" }],
        "datasets/new/영천시_비과세감면.csv"
      ),
      source(
        "property_valuation_microdata",
        ["법정동", "물건지", "시가표준액"],
        [{ 법정동: "비공개", 물건지: "비공개", 시가표준액: "1" }],
        "datasets/new/김천시_일반건축물.csv"
      )
    ]);
    expect(result.quarantinedRows).toBe(1);
    expect(result.excludedPropertyRows).toBe(1);
    expect(result.headlineRevenue).toHaveLength(0);
    expect(result.qualityIssues.map((item) => item.issueCode)).toEqual(
      expect.arrayContaining([
        "unverified_column_semantics_quarantined",
        "property_microdata_privacy_excluded"
      ])
    );
  });

  it("validates years, canonical codes, aggregate detail, and deterministic reruns", () => {
    expect(parseTaxYear("14", { allowTwoDigit: true, currentYear: 2026 })).toBe(2014);
    expect(parseTaxYear("99", { allowTwoDigit: true, currentYear: 2026 })).toBeNull();
    expect(
      resolveTaxRegionIdentity({ regionCode: "47250", regionName: "상주시" }).region
    ).toMatchObject({ regionId: "47250" });
    expect(
      resolveTaxRegionIdentity({ regionCode: "47250", regionName: "구미시" }).error
    ).toContain("mismatch");

    const input = source(
      "local_tax_collection",
      ["시군구명", "자치단체코드", "과세년도", "세목명", "부과금액(원)", "수납급액(원)", "환급금액(원)", "결손금액(원)", "미수납 금액(원)"],
      [
        { 시군구명: "상주시", 자치단체코드: "47250", 과세년도: "2024", 세목명: "합계", "부과금액(원)": "30", "수납급액(원)": "25", "환급금액(원)": "0", "결손금액(원)": "0", "미수납 금액(원)": "5" },
        { 시군구명: "상주시", 자치단체코드: "47250", 과세년도: "2024", 세목명: "주민세", "부과금액(원)": "10", "수납급액(원)": "10", "환급금액(원)": "0", "결손금액(원)": "0", "미수납 금액(원)": "0" },
        { 시군구명: "상주시", 자치단체코드: "47250", 과세년도: "2024", 세목명: "재산세", "부과금액(원)": "20", "수납급액(원)": "15", "환급금액(원)": "0", "결손금액(원)": "0", "미수납 금액(원)": "5" }
      ]
    );
    const first = normalizeLocalTaxSources([input]);
    const second = normalizeLocalTaxSources([input]);
    expect(first).toEqual(second);
    expect(first.reconciliations[0]).toMatchObject({
      reconciliationCode: "collection_aggregate_vs_detail",
      status: "passed"
    });
    expect(first.headlineRevenue.filter((row) => row.taxCategory === "합계")).toHaveLength(1);

    const conflictingUnits = normalizeLocalTaxSources([
      source(
        "local_tax_collection",
        ["시군구명", "자치단체코드", "과세년도", "세목명", "부과금액(천원)", "수납급액(원)", "환급금액(원)", "결손금액(원)", "미수납 금액(원)"],
        [{
          시군구명: "상주시",
          자치단체코드: "47250",
          과세년도: "2024",
          세목명: "합계",
          "부과금액(천원)": "1",
          "수납급액(원)": "1",
          "환급금액(원)": "0",
          "결손금액(원)": "0",
          "미수납 금액(원)": "0"
        }]
      )
    ]);
    expect(conflictingUnits.qualityIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueCode: "conflicting_money_units",
          severity: "error",
          quarantined: true
        })
      ])
    );
  });
});
