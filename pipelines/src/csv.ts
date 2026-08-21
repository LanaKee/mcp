import { parse } from "csv-parse/sync";
import iconv from "iconv-lite";

export type CsvKind =
  | "population_annual"
  | "population_local"
  | "council_agenda"
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

const numberValue = (value: string) => Number(value.replace(/[,\s]/g, "")) || 0;

export interface NormalizedPopulationRow {
  regionName: string;
  year: number;
  populationTotal: number;
  sourceRow: number;
}

export function inferRegionName(pathName: string): string {
  const normalized = pathName.normalize("NFC");
  const match = normalized.match(/경상북도[_\s]+([^_]+?시|[^_]+?군)(?:_|\\s)/);
  if (match?.[1]) return match[1].replace(/\s+/g, "");
  return "미확인";
}

export function normalizeAnnualPopulation(
  decoded: DecodedCsv,
  pathName: string
): NormalizedPopulationRow[] {
  if (decoded.kind !== "population_annual") return [];
  const regionName = inferRegionName(pathName);
  return decoded.rows
    .map((row, index) => {
      const date = firstValue(row, ["년월", "연월", "기준연월"]);
      const year = Number(date.slice(0, 4));
      const populationTotal =
        numberValue(firstValue(row, ["한국인남"])) +
        numberValue(firstValue(row, ["한국인여"])) +
        numberValue(firstValue(row, ["외국인남"])) +
        numberValue(firstValue(row, ["외국인여"]));
      return { regionName, year, populationTotal, sourceRow: index + 2 };
    })
    .filter((row) => row.year >= 1900 && row.populationTotal > 0);
}

export interface NormalizedCouncilRow {
  regionName: string;
  title: string;
  recordNumber: string;
  proposer: string;
  meetingDate: string | null;
  result: string | null;
  sourceRow: number;
}

export function normalizeCouncilRows(
  decoded: DecodedCsv,
  pathName: string
): NormalizedCouncilRow[] {
  if (decoded.kind !== "council_agenda") return [];
  const regionName = inferRegionName(pathName);
  return decoded.rows
    .map((row, index) => {
      const title = firstValue(row, ["의안명", "안건명", "건명"]);
      return {
        regionName,
        title,
        recordNumber: firstValue(row, ["의안번호", "안건번호", "연번"]),
        proposer: firstValue(row, ["발의자", "제안자", "제출자"]),
        meetingDate:
          firstValue(row, [
            "회의일자",
            "발의일자",
            "발의일",
            "제안일",
            "본회의 처리일",
            "본회의처리일"
          ]) || null,
        result:
          firstValue(row, [
            "본회의 결과",
            "본회의결과",
            "본회의처리결과",
            "본회의-처리결과",
            "의안처리결과",
            "결과"
          ]) || null,
        sourceRow: index + 2
      };
    })
    .filter((row) => row.title.length > 0);
}

