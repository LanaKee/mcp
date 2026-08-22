import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import {
  inferRegionName,
  normalizeAnnualPopulation,
  normalizeCouncilRows,
  normalizePressReleaseRows,
  normalizePopulationSnapshot,
  parseKoreanCsv
} from "./csv.js";

describe("dataset CSV adapters", () => {
  it("decodes CP949 and normalizes Pohang annual population", () => {
    const text =
      "년월, 한국인남,한국인여,외국인남,외국인여\n2024-12-01,240000,238000,1800,1200\n";
    const decoded = parseKoreanCsv(iconv.encode(text, "cp949"));
    expect(decoded.encoding).toBe("cp949");
    expect(
      normalizeAnnualPopulation(
        decoded,
        "경상북도_포항시_연도별.csv"
      )
    ).toEqual([
      {
        regionName: "포항시",
        referenceDate: "2024-12-01",
        populationTotal: 481000,
        populationMale: 241800,
        populationFemale: 239200,
        householdCount: null,
        foreignPopulation: 3000,
        measurementBasis: "resident_registration_snapshot",
        referenceDatePrecision: "month",
        metadata: {
          sourcePeriodField: "년월"
        },
        sourceRow: 2
      }
    ]);
  });

  it("aggregates municipality snapshots and preserves their exact date", () => {
    const decoded = parseKoreanCsv(
      Buffer.from(
        [
          "구분,세대수,계,남,여,데이터기준일자",
          "선산읍,10,21,11,10,2026-02-28",
          "고아읍,20,42,20,22,2026-02-28"
        ].join("\n")
      )
    );
    expect(
      normalizePopulationSnapshot(
        decoded,
        "경상북도_구미시_인구현황_20260228.csv",
        "2026-02-28"
      )
    ).toEqual([
      {
        regionName: "구미시",
        referenceDate: "2026-02-28",
        populationTotal: 63,
        populationMale: 31,
        populationFemale: 32,
        householdCount: 30,
        foreignPopulation: null,
        measurementBasis: "resident_registration_snapshot",
        referenceDatePrecision: "day",
        metadata: {
          sourceGrain: "summed_submunicipal_rows",
          sourceRowStart: 2,
          sourceRowEnd: 3
        },
        sourceRow: 2
      }
    ]);
  });

  it("normalizes province municipality summary rows independently", () => {
    const decoded = parseKoreanCsv(
      Buffer.from("시군별,세대수,인구\n구미시,190000,404691\n청도군,23000,40778\n")
    );
    expect(decoded.kind).toBe("population_local");
    expect(
      normalizePopulationSnapshot(
        decoded,
        "경상북도_행정구역현황_20250930.csv",
        "2025-09-30"
      )
    ).toMatchObject([
      {
        regionName: "구미시",
        referenceDate: "2025-09-30",
        populationTotal: 404691
      },
      {
        regionName: "청도군",
        referenceDate: "2025-09-30",
        populationTotal: 40778
      }
    ]);
  });

  it("detects council rows from headers rather than the filename", () => {
    const decoded = parseKoreanCsv(
      Buffer.from("의안번호,의안명,발의자,발의일자,본회의결과\n1,청년 지원 조례안,홍길동,2024-01-02,가결\n")
    );
    expect(normalizeCouncilRows(decoded, "경상북도_상주시_의안.csv")[0]).toMatchObject({
      title: "청년 지원 조례안",
      proposer: "홍길동",
      meetingDate: "2024-01-02",
      result: "가결"
    });
  });

  it("detects press release rows from the crawler's header contract", () => {
    const decoded = parseKoreanCsv(
      Buffer.from(
        "source_record_id,published_date,published_at,province_name,department,phone,author,title,subheadings,body,attachment_names,view_count,body_sha256,detail_url\n" +
          '100,2026-08-21,2026-08-21T09:30:00,경상북도,메타버스과,054-880-1234,홍길동,청년 창업 지원,"부제1 | 부제2","본문 첫 문단.\n\n둘째 문단.","보도자료.hwp | 사진.jpg",1234,' +
          `${"b".repeat(64)},https://www.gb.go.kr/detail\n`
      )
    );
    expect(decoded.kind).toBe("press_release");
    expect(normalizePressReleaseRows(decoded, "gb_press.csv")[0]).toMatchObject({
      sourceRecordId: "100",
      title: "청년 창업 지원",
      provinceName: "경상북도",
      department: "메타버스과",
      contactPhone: "054-880-1234",
      author: "홍길동",
      subheadings: ["부제1", "부제2"],
      attachmentNames: ["보도자료.hwp", "사진.jpg"],
      publishedDate: "2026-08-21",
      publishedAt: "2026-08-21T09:30:00",
      viewCount: 1234,
      sourceRow: 2
    });
  });

  it("does not mistake press release rows for council agenda rows", () => {
    const decoded = parseKoreanCsv(
      Buffer.from("의안번호,의안명,발의자\n1,조례안,홍길동\n")
    );
    expect(decoded.kind).toBe("council_agenda");
    expect(normalizePressReleaseRows(decoded, "council.csv")).toEqual([]);
  });

  it("normalizes NFD filenames without exact filename matching", () => {
    expect(inferRegionName("경상북도_상주시_자료.csv")).toBe("상주시");
  });

  it("maps the provincial council to Gyeongbuk rather than an unresolved region", () => {
    expect(inferRegionName("경상북도_경북도의회 회의록 안건정보.csv")).toBe(
      "경상북도"
    );
  });
});
