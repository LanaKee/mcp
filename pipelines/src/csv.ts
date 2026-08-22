import { parse } from "csv-parse/sync";
import iconv from "iconv-lite";
import { parseReferenceDate } from "./dates.js";
import { recoverHwpMarkupBody } from "./gb-press-release.js";
import {
  detectLocalTaxCsvKind,
  type LocalTaxCsvKind
} from "./local-tax.js";
import type { NormalizedPopulationObservation } from "./population.js";
import {
  gyeongbukAdapter,
  type RegionAdapter
} from "./region-adapter.js";

export type CsvKind =
  | "population_annual"
  | "population_local"
  | "council_agenda"
  | "press_release"
  | "council_member"
  | "council_bill"
  | "council_bill_sponsor"
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
    compact.includes("시군별") &&
    compact.includes("세대수") &&
    compact.includes("인구")
  ) {
    return "population_local";
  }
  if (
    ["source_record_id", "title", "body", "body_sha256"].every((header) =>
      compact.includes(header)
    )
  ) {
    return "press_release";
  }
  // The council CSVs are checked before the generic 의안/안건 heuristic because
  // the bill file also carries a 의안번호-equivalent column.
  if (
    ["bill_uid", "role", "member_name"].every((header) => compact.includes(header))
  ) {
    return "council_bill_sponsor";
  }
  if (
    ["bill_uid", "title", "detail_url"].every((header) => compact.includes(header))
  ) {
    return "council_bill";
  }
  if (
    ["search_code", "name", "homepage_url"].every((header) =>
      compact.includes(header)
    )
  ) {
    return "council_member";
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

export type NormalizedPopulationRow = NormalizedPopulationObservation;

/**
 * Resolves the region a file belongs to.
 *
 * The province adapter is a parameter rather than an import so the same
 * normalisers can load another province's files unchanged. It defaults to
 * Gyeongbuk because every currently loaded source is Gyeongbuk, and a caller
 * that forgets to pass one should get the province we actually have data for
 * rather than a silent cross-province match.
 */
export function inferRegionName(
  pathName: string,
  adapter: RegionAdapter = gyeongbukAdapter
): string | null {
  return adapter.infer(pathName)?.regionName ?? null;
}

export function normalizeAnnualPopulation(
  decoded: DecodedCsv,
  pathName: string,
  adapter: RegionAdapter = gyeongbukAdapter
): NormalizedPopulationRow[] {
  if (decoded.kind !== "population_annual") return [];
  const regionName = inferRegionName(pathName, adapter);
  if (!regionName) return [];
  return decoded.rows.flatMap((row, index) => {
      const referenceDate = parseReferenceDate(
        firstValue(row, ["년월", "연월", "기준연월"])
      );
      const koreanMale = numberValue(firstValue(row, ["한국인남"]));
      const koreanFemale = numberValue(firstValue(row, ["한국인여"]));
      const foreignMale = numberValue(firstValue(row, ["외국인남"]));
      const foreignFemale = numberValue(firstValue(row, ["외국인여"]));
      const populationMale = koreanMale + foreignMale;
      const populationFemale = koreanFemale + foreignFemale;
      return referenceDate && populationMale + populationFemale > 0
        ? [{
        regionName,
        referenceDate,
        populationTotal: populationMale + populationFemale,
        populationMale,
        populationFemale,
        householdCount: numberValue(firstValue(row, ["세대수"])) || null,
        foreignPopulation: foreignMale + foreignFemale,
        measurementBasis: "resident_registration_snapshot" as const,
        referenceDatePrecision: "month" as const,
        metadata: {
          sourcePeriodField: "년월"
        },
        sourceRow: index + 2
          }]
        : [];
    });
}

export function normalizePopulationSnapshot(
  decoded: DecodedCsv,
  pathName: string,
  catalogReferenceDate: string | null,
  adapter: RegionAdapter = gyeongbukAdapter
): NormalizedPopulationRow[] {
  if (decoded.kind !== "population_local") return [];
  const isMunicipalityTable = decoded.headers.some(
    (header) => clean(header) === "시군별"
  );
  if (isMunicipalityTable) {
    return decoded.rows.flatMap((row, index) => {
      const region = adapter.infer(firstValue(row, ["시군별"]));
      const populationTotal = numberValue(firstValue(row, ["인구"]));
      const referenceDate = catalogReferenceDate
        ? parseReferenceDate(catalogReferenceDate)
        : null;
      return region && referenceDate && populationTotal > 0
        ? [{
            regionName: region.regionName,
            referenceDate,
            populationTotal,
            populationMale: null,
            populationFemale: null,
            householdCount:
              numberValue(firstValue(row, ["세대수"])) || null,
            foreignPopulation: null,
            measurementBasis: "resident_registration_snapshot" as const,
            referenceDatePrecision: "day" as const,
            metadata: {
              sourceGrain: "municipality_summary_row"
            },
            sourceRow: index + 2
          }]
        : [];
    });
  }

  const regionName = inferRegionName(pathName, adapter);
  if (!regionName) return [];
  const rowDates = [
    ...new Set(
      decoded.rows
        .map((row) =>
          parseReferenceDate(
            firstValue(row, ["데이터기준일자", "데이터기준일"])
          )
        )
        .filter((value): value is string => value !== null)
    )
  ];
  if (rowDates.length > 1) return [];
  const referenceDate =
    rowDates.length === 1
      ? rowDates[0]!
      : catalogReferenceDate
        ? parseReferenceDate(catalogReferenceDate)
        : null;
  if (!referenceDate) return [];

  let populationTotal = 0;
  let populationMale = 0;
  let populationFemale = 0;
  let householdCount = 0;
  let hasMale = false;
  let hasFemale = false;
  let hasHouseholds = false;
  for (const row of decoded.rows) {
    populationTotal += numberValue(
      firstValue(row, ["총인구수", "계", "인구수", "인구"])
    );
    const male = numberValue(
      firstValue(row, ["남자수", "남", "인구수_남", "인구수(남)"])
    );
    const female = numberValue(
      firstValue(row, ["여자수", "여", "인구수_여", "인구수(여)"])
    );
    const households = numberValue(firstValue(row, ["세대수", "세대"]));
    populationMale += male;
    populationFemale += female;
    householdCount += households;
    hasMale ||= male > 0;
    hasFemale ||= female > 0;
    hasHouseholds ||= households > 0;
  }
  if (populationTotal <= 0) return [];
  return [{
    regionName,
    referenceDate,
    populationTotal,
    populationMale: hasMale ? populationMale : null,
    populationFemale: hasFemale ? populationFemale : null,
    householdCount: hasHouseholds ? householdCount : null,
    foreignPopulation: null,
    measurementBasis: "resident_registration_snapshot",
    referenceDatePrecision: "day",
    metadata: {
      sourceGrain: "summed_submunicipal_rows",
      sourceRowStart: 2,
      sourceRowEnd: decoded.rows.length + 1
    },
    sourceRow: 2
  }];
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

export interface NormalizedPressReleaseRow {
  sourceRecordId: string;
  title: string;
  body: string;
  bodySha256: string;
  provinceName: string;
  department: string | null;
  contactPhone: string | null;
  author: string | null;
  subheadings: string[];
  attachmentNames: string[];
  publishedDate: string | null;
  publishedAt: string | null;
  viewCount: number | null;
  detailUrl: string;
  sourceRow: number;
}

const pressListValue = (value: string): string[] =>
  value
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const semicolonListValue = (value: string): string[] =>
  value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

export function normalizePressReleaseRows(
  decoded: DecodedCsv,
  pathName: string
): NormalizedPressReleaseRow[] {
  if (decoded.kind !== "press_release") return [];
  const fallbackProvince = inferRegionName(pathName) ?? "경상북도";
  return decoded.rows
    .map((row, index) => {
      const publishedAt = firstValue(row, ["published_at"]);
      const viewCount = Number.parseInt(firstValue(row, ["view_count"]), 10);
      const capturedBody = firstValue(row, ["body"]);
      const body = recoverHwpMarkupBody(capturedBody);
      return {
        sourceRecordId: firstValue(row, ["source_record_id"]),
        title: firstValue(row, ["title"]),
        body,
        // Recovering a body invalidates the captured digest, so drop it and let
        // the planner hash what is actually stored.
        bodySha256:
          body === capturedBody ? firstValue(row, ["body_sha256"]) : "",
        provinceName: firstValue(row, ["province_name"]) || fallbackProvince,
        department: firstValue(row, ["department"]) || null,
        contactPhone: firstValue(row, ["phone"]) || null,
        author: firstValue(row, ["author"]) || null,
        subheadings: pressListValue(firstValue(row, ["subheadings"])),
        attachmentNames: pressListValue(firstValue(row, ["attachment_names"])),
        publishedDate: parseReferenceDate(firstValue(row, ["published_date"])),
        publishedAt: publishedAt || null,
        viewCount: Number.isFinite(viewCount) ? viewCount : null,
        detailUrl: firstValue(row, ["detail_url"]),
        sourceRow: index + 2
      };
    })
    .filter((row) => row.sourceRecordId.length > 0 && row.title.length > 0);
}

export interface NormalizedCouncilMemberRow {
  searchCode: string;
  siteMemberId: string | null;
  name: string;
  party: string | null;
  district: string | null;
  position: string | null;
  officePhone: string | null;
  education: string | null;
  career: string | null;
  photoUrl: string | null;
  homepageUrl: string;
  sourceRow: number;
}

export function normalizeCouncilMemberRows(
  decoded: DecodedCsv
): NormalizedCouncilMemberRow[] {
  if (decoded.kind !== "council_member") return [];
  return decoded.rows
    .map((row, index) => ({
      searchCode: firstValue(row, ["search_code"]),
      siteMemberId: firstValue(row, ["site_member_id"]) || null,
      name: firstValue(row, ["name"]),
      party: firstValue(row, ["party"]) || null,
      district: firstValue(row, ["district"]) || null,
      position: firstValue(row, ["position"]) || null,
      officePhone: firstValue(row, ["office_phone"]) || null,
      education: firstValue(row, ["education"]) || null,
      career: firstValue(row, ["career"]) || null,
      photoUrl: firstValue(row, ["photo_url"]) || null,
      homepageUrl: firstValue(row, ["homepage_url"]),
      sourceRow: index + 2
    }))
    .filter((row) => row.searchCode.length > 0 && row.name.length > 0);
}

export interface NormalizedCouncilBillRow {
  billUid: string;
  billNumber: string | null;
  title: string;
  billKind: string | null;
  proposerKind: string | null;
  committee: string | null;
  sessionName: string | null;
  proposedDate: string | null;
  decidedDate: string | null;
  status: string | null;
  outcome: string | null;
  leadSponsors: string[];
  coSponsorCount: number;
  detailUrl: string;
  sourceRow: number;
}

export function normalizeCouncilBillRows(
  decoded: DecodedCsv
): NormalizedCouncilBillRow[] {
  if (decoded.kind !== "council_bill") return [];
  return decoded.rows
    .map((row, index) => {
      const coSponsorCount = Number.parseInt(
        firstValue(row, ["co_sponsor_count"]),
        10
      );
      return {
        billUid: firstValue(row, ["bill_uid"]).toUpperCase(),
        billNumber: firstValue(row, ["bill_number"]) || null,
        title: firstValue(row, ["title"]),
        billKind: firstValue(row, ["bill_kind"]) || null,
        proposerKind: firstValue(row, ["proposer_kind"]) || null,
        committee: firstValue(row, ["committee"]) || null,
        sessionName: firstValue(row, ["session"]) || null,
        proposedDate: parseReferenceDate(firstValue(row, ["proposed_date"])),
        decidedDate: parseReferenceDate(firstValue(row, ["decided_date"])),
        status: firstValue(row, ["status"]) || null,
        outcome: firstValue(row, ["outcome"]) || null,
        leadSponsors: semicolonListValue(firstValue(row, ["lead_sponsors"])),
        coSponsorCount: Number.isFinite(coSponsorCount) ? coSponsorCount : 0,
        detailUrl: firstValue(row, ["detail_url"]),
        sourceRow: index + 2
      };
    })
    .filter((row) => row.billUid.length > 0 && row.title.length > 0);
}

export interface NormalizedCouncilBillSponsorRow {
  billUid: string;
  role: string;
  memberName: string;
  searchCode: string | null;
  sourceRow: number;
}

export function normalizeCouncilBillSponsorRows(
  decoded: DecodedCsv
): NormalizedCouncilBillSponsorRow[] {
  if (decoded.kind !== "council_bill_sponsor") return [];
  return decoded.rows
    .map((row, index) => ({
      billUid: firstValue(row, ["bill_uid"]).toUpperCase(),
      role: firstValue(row, ["role"]),
      memberName: firstValue(row, ["member_name"]),
      searchCode: firstValue(row, ["search_code"]) || null,
      sourceRow: index + 2
    }))
    .filter((row) => row.billUid.length > 0 && row.memberName.length > 0);
}
