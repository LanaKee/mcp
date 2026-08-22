import { normalizeRegionName } from "@gb/domain";

/** Region names the extractor will recognise in free text. */
const GYEONGBUK_REGIONS = [
  "포항시",
  "경주시",
  "김천시",
  "안동시",
  "구미시",
  "영주시",
  "영천시",
  "상주시",
  "문경시",
  "경산시",
  "의성군",
  "청송군",
  "영양군",
  "영덕군",
  "청도군",
  "고령군",
  "성주군",
  "칠곡군",
  "예천군",
  "봉화군",
  "울진군",
  "울릉군",
  "군위군"
] as const;

export interface ExtractedEntities {
  region: string | null;
  startYear: number | null;
  endYear: number | null;
  age: number | null;
}

/**
 * Pulls the arguments tools need out of a natural-language question.
 *
 * Matching accepts the bare stem ("상주") as well as the full name ("상주시")
 * because people rarely type the administrative suffix.
 */
export function extractEntities(question: string): ExtractedEntities {
  const text = question.normalize("NFC");

  let region: string | null = null;
  for (const candidate of GYEONGBUK_REGIONS) {
    const stem = candidate.slice(0, -1);
    if (text.includes(candidate) || text.includes(stem)) {
      region = candidate;
      break;
    }
  }

  const years = [...text.matchAll(/\b(19\d{2}|20\d{2})\s*년?/gu)]
    .map((match) => Number(match[1]))
    .filter((year) => year >= 1990 && year <= 2100);
  const uniqueYears = [...new Set(years)].sort((left, right) => left - right);

  const ageMatch = text.match(/(\d{1,3})\s*(?:세|살)/u);
  const age = ageMatch ? Number(ageMatch[1]) : null;

  return {
    region,
    startYear: uniqueYears[0] ?? null,
    endYear: uniqueYears.at(-1) ?? uniqueYears[0] ?? null,
    age: age !== null && age >= 0 && age <= 120 ? age : null
  };
}

export { GYEONGBUK_REGIONS, normalizeRegionName };
