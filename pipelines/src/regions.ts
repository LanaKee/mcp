export interface GyeongbukRegion {
  regionId: string;
  regionName: string;
  regionType: "province" | "city" | "county";
  parentRegionId: string | null;
  aliases: readonly string[];
}

function municipality(
  regionId: string,
  regionName: string,
  regionType: "city" | "county"
): GyeongbukRegion {
  const shortName = regionName.slice(0, -1);
  return {
    regionId,
    regionName,
    regionType,
    parentRegionId: "47",
    aliases: [
      shortName,
      `${regionName}청`,
      `${regionName}의회`,
      `${shortName}${regionType === "city" ? "시의회" : "군의회"}`
    ]
  };
}

export const GYEONGBUK_REGIONS: readonly GyeongbukRegion[] = [
  {
    regionId: "47",
    regionName: "경상북도",
    regionType: "province",
    parentRegionId: null,
    aliases: ["경북", "경북도", "경상북도청", "경북도청", "경상북도의회", "경북도의회"]
  },
  municipality("47110", "포항시", "city"),
  municipality("47130", "경주시", "city"),
  municipality("47150", "김천시", "city"),
  municipality("47170", "안동시", "city"),
  municipality("47190", "구미시", "city"),
  municipality("47210", "영주시", "city"),
  municipality("47230", "영천시", "city"),
  municipality("47250", "상주시", "city"),
  municipality("47280", "문경시", "city"),
  municipality("47290", "경산시", "city"),
  municipality("47730", "의성군", "county"),
  municipality("47750", "청송군", "county"),
  municipality("47760", "영양군", "county"),
  municipality("47770", "영덕군", "county"),
  municipality("47820", "청도군", "county"),
  municipality("47830", "고령군", "county"),
  municipality("47840", "성주군", "county"),
  municipality("47850", "칠곡군", "county"),
  municipality("47900", "예천군", "county"),
  municipality("47920", "봉화군", "county"),
  municipality("47930", "울진군", "county"),
  municipality("47940", "울릉군", "county")
];

function compact(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\.[^.]+$/u, "")
    .replace(/[^0-9가-힣]/gu, "");
}

const municipalityRegions = GYEONGBUK_REGIONS.filter(
  (region) => region.regionType !== "province"
);
const provinceRegion = GYEONGBUK_REGIONS[0]!;

export function resolveGyeongbukRegion(value: string): GyeongbukRegion | null {
  const normalized = compact(value);
  if (!normalized || normalized.includes("군위")) return null;

  for (const region of municipalityRegions) {
    const candidates = [region.regionName, ...region.aliases].map(compact);
    if (candidates.some((candidate) => normalized === candidate)) return region;
  }

  for (const region of municipalityRegions) {
    if (normalized.includes(compact(region.regionName))) return region;
  }

  const provinceCandidates = [provinceRegion.regionName, ...provinceRegion.aliases].map(compact);
  if (provinceCandidates.some((candidate) => normalized === candidate)) return provinceRegion;
  if (
    normalized.includes("경북도의회") ||
    normalized.includes("경상북도의회")
  ) {
    return provinceRegion;
  }
  return null;
}

export function inferGyeongbukRegion(
  ...values: Array<string | null | undefined>
): GyeongbukRegion | null {
  for (const value of values) {
    if (!value) continue;
    const region = resolveGyeongbukRegion(value);
    if (region) return region;
  }
  return null;
}
