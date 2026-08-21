import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import {
  inferRegionName,
  normalizeAnnualPopulation,
  normalizeCouncilRows,
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
        sourceRow: 2
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

  it("normalizes NFD filenames without exact filename matching", () => {
    expect(inferRegionName("경상북도_상주시_자료.csv")).toBe("상주시");
  });

  it("maps the provincial council to Gyeongbuk rather than an unresolved region", () => {
    expect(inferRegionName("경상북도_경북도의회 회의록 안건정보.csv")).toBe(
      "경상북도"
    );
  });
});
