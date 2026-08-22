import { parse } from "csv-parse/sync";
import iconv from "iconv-lite";
import { parseReferenceDate } from "./dates.js";
import {
  detectLocalTaxCsvKind,
  type LocalTaxCsvKind
} from "./local-tax.js";
import { inferGyeongbukRegion } from "./regions.js";

export type CsvKind =
  | "population_annual"
  | "population_local"
  | "council_agenda"
  | LocalTaxCsvKind
  | "other";

export interface DecodedCsv {
  encoding: "utf8" | "cp949";
  headers: string[];
  rows: Record<string, string>[];
  kind: CsvKind;
}

const clean = (value: string) => value.normalize("NFC").replace(/^\uFEFF/, "").trim();

export function decodeKoreanCsv(buffer: Buffer): {
  text: string;
  encoding: "utf8" | "cp949";
} {
  const utf8 = buffer.toString("utf8");
  const replacementCount = (utf8.match(/\uFFFD/g) ?? []).length;
  if (replacementCount === 0) return { text: utf8, encoding: "utf8" };
  return { text: iconv.decode(buffer, "cp949"), encoding: "cp949" };
}

export function detectCsvKind(headers: string[]): CsvKind {
  const localTaxKind = detectLocalTaxCsvKind(headers);
  if (localTaxKind) return localTaxKind;
  const compact = headers.map(clean).join("|");
  if (
    compact.includes("년월") &&
    compact.includes("한국인남") &&
    compact.includes("한국인여")
  ) {
    return "population_annual";
  }
  if (
    (compact.includes("인구수") || compact.includes("|계|")) &&
    (compact.includes("읍면") || compact.includes("행정기관") || compact.includes("구분"))
  ) {
    return "population_local";
  }
  if (
    ["의안명", "안건명", "건명"].some((header) => compact.includes(header)) &&
    ["의안번호", "안건번호", "연번"].some((header) => compact.includes(header))
  ) {
    return "council_agenda";
  }
  return "other";
}

export function parseKoreanCsv(buffer: Buffer): DecodedCsv {
  const { text, encoding } = decodeKoreanCsv(buffer);
  const records = parse(text, {
    bom: true,
    columns: (headers: string[]) => headers.map(clean),
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true
  }) as Record<string, unknown>[];
  const rows = records.map((record) =>
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => [
        clean(key),
        value === undefined || value === null ? "" : clean(String(value))
      ])
    )
  );
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  return { encoding, headers, rows, kind: detectCsvKind(headers) };
}

function firstValue(row: Record<string, string>, aliases: string[]): string {
  for (const alias of aliases) {
    const key = Object.keys(row).find((candidate) => clean(candidate) === alias);
    if (key && row[key]) return row[key];
  }
  return "";
}

function objectArrayValue(value: string): Record<string, unknown>[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null && !Array.isArray(item)
        )
      : [];
  } catch {
    return [];
  }
}

const numberValue = (value: string) => Number(value.replace(/[,\s]/g, "")) || 0;

export interface NormalizedPopulationRow {
  regionName: string;
  referenceDate: string;
  populationTotal: number;
  populationMale: number;
  populationFemale: number;
  householdCount: number | null;
  foreignPopulation: number;
  sourceRow: number;
}

export function inferRegionName(pathName: string): string | null {
  return inferGyeongbukRegion(pathName)?.regionName ?? null;
}

export function normalizeAnnualPopulation(
  decoded: DecodedCsv,
  pathName: string
): NormalizedPopulationRow[] {
  if (decoded.kind !== "population_annual") return [];
  const regionName = inferRegionName(pathName);
  if (!regionName) return [];
  return decoded.rows
    .map((row, index) => {
      const referenceDate = parseReferenceDate(
        firstValue(row, ["년월", "연월", "기준연월"])
      );
      const koreanMale = numberValue(firstValue(row, ["한국인남"]));
      const koreanFemale = numberValue(firstValue(row, ["한국인여"]));
      const foreignMale = numberValue(firstValue(row, ["외국인남"]));
      const foreignFemale = numberValue(firstValue(row, ["외국인여"]));
      const populationMale = koreanMale + foreignMale;
      const populationFemale = koreanFemale + foreignFemale;
      return {
        regionName,
        referenceDate,
        populationTotal: populationMale + populationFemale,
        populationMale,
        populationFemale,
        householdCount: numberValue(firstValue(row, ["세대수"])) || null,
        foreignPopulation: foreignMale + foreignFemale,
        sourceRow: index + 2
      };
    })
    .filter(
      (row): row is NormalizedPopulationRow =>
        row.referenceDate !== null && row.populationTotal > 0
    );
}

export interface NormalizedCouncilRow {
  regionName: string;
  title: string;
  recordNumber: string;
  proposer: string;
  councilName: string;
  sessionName: string | null;
  meetingDate: string | null;
  result: string | null;
  sourceRecordId: string;
  detailUrl: string;
  dataQualityIssues: Record<string, unknown>[];
  sourceRow: number;
}

export function normalizeCouncilRows(
  decoded: DecodedCsv,
  pathName: string
): NormalizedCouncilRow[] {
  if (decoded.kind !== "council_agenda") return [];
  const regionName = inferRegionName(pathName);
  if (!regionName) return [];
  const councilName =
    regionName === "경상북도" ? "경상북도의회" : `${regionName}의회`;
  return decoded.rows
    .map((row, index) => {
      const title = firstValue(row, ["의안명", "안건명", "건명"]);
      const rawMeetingDate = firstValue(row, [
        "회의일자",
        "발의일자",
        "발의일",
        "제안일",
        "본회의 처리일",
        "본회의처리일",
        "본회의-처리일"
      ]);
      return {
        regionName,
        title,
        recordNumber: firstValue(row, ["의안번호", "안건번호", "연번"]),
        proposer: firstValue(row, [
          "발의자",
          "제안자",
          "제출자",
          "제출(발의)자"
        ]),
        councilName,
        sessionName: firstValue(row, ["회기", "회기정보", "기"]) || null,
        meetingDate: parseReferenceDate(rawMeetingDate),
        result:
          firstValue(row, [
            "본회의 결과",
            "본회의결과",
            "본회의처리결과",
            "본회의-처리결과",
            "의안처리결과",
            "결과"
          ]) || null,
        sourceRecordId: firstValue(row, ["원문레코드ID"]),
        detailUrl: firstValue(row, ["원문URL"]),
        dataQualityIssues: objectArrayValue(
          firstValue(row, ["데이터품질이슈"])
        ),
        sourceRow: index + 2
      };
    })
    .filter((row) => row.title.length > 0);
}
