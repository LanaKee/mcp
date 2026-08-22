/**
 * Province-agnostic administrative region resolution.
 *
 * Region normalisation was the one part of the pipeline that hard-coded a
 * single province, which made every downstream claim about portability
 * unverifiable. The rules themselves - exact name, then containment, then the
 * province's own council forms - were never Gyeongbuk-specific; only the list
 * of names was. Splitting the two turns "another municipality could adopt
 * this" from an assertion into a configuration file plus a test.
 *
 * A province is described, not coded: codes, names, and the municipalities
 * that belong to it. Alias forms (청, 의회, 시의회/군의회) are derived rather
 * than listed, because a name that needs hand-written aliases is a name whose
 * conventions we have not actually understood.
 */

export type RegionType = "province" | "city" | "county";

export interface AdministrativeRegion {
  regionId: string;
  regionName: string;
  regionType: RegionType;
  parentRegionId: string | null;
  aliases: readonly string[];
}

export interface MunicipalityConfig {
  /** Statistical code, e.g. the first five digits of the legal-dong code. */
  readonly code: string;
  readonly name: string;
  readonly type: "city" | "county";
}

export interface ProvinceRegionConfig {
  /** Two-digit province code. */
  readonly code: string;
  readonly name: string;
  /** Short forms in common use, e.g. 경북 for 경상북도. */
  readonly shortNames: readonly string[];
  readonly municipalities: readonly MunicipalityConfig[];
  /**
   * Names that must never resolve, such as a municipality transferred to
   * another province. Silently resolving them would attribute one province's
   * figures to another.
   */
  readonly retiredNames?: readonly string[];
}

export interface RegionAdapter {
  readonly config: ProvinceRegionConfig;
  readonly regions: readonly AdministrativeRegion[];
  readonly province: AdministrativeRegion;
  resolve(value: string): AdministrativeRegion | null;
  infer(...values: Array<string | null | undefined>): AdministrativeRegion | null;
  byId(regionId: string): AdministrativeRegion | null;
}

function compact(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\.[^.]+$/u, "")
    .replace(/[^0-9가-힣]/gu, "");
}

function municipalityRegion(
  provinceCode: string,
  municipality: MunicipalityConfig
): AdministrativeRegion {
  const shortName = municipality.name.slice(0, -1);
  return {
    regionId: municipality.code,
    regionName: municipality.name,
    regionType: municipality.type,
    parentRegionId: provinceCode,
    aliases: [
      shortName,
      `${municipality.name}청`,
      `${municipality.name}의회`,
      `${shortName}${municipality.type === "city" ? "시의회" : "군의회"}`
    ]
  };
}

function provinceRegion(config: ProvinceRegionConfig): AdministrativeRegion {
  const names = [config.name, ...config.shortNames];
  return {
    regionId: config.code,
    regionName: config.name,
    regionType: "province",
    parentRegionId: null,
    aliases: [
      ...config.shortNames,
      ...names.map((name) => `${name}청`),
      ...names.map((name) => `${name}의회`)
    ]
  };
}

export function createRegionAdapter(config: ProvinceRegionConfig): RegionAdapter {
  const province = provinceRegion(config);
  const municipalities = config.municipalities.map((municipality) =>
    municipalityRegion(config.code, municipality)
  );
  const regions = [province, ...municipalities];
  const retired = (config.retiredNames ?? []).map(compact);
  const provinceNames = [province.regionName, ...province.aliases].map(compact);
  const provinceCouncilNames = [province.regionName, ...config.shortNames].map(
    (name) => compact(`${name}의회`)
  );

  function resolve(value: string): AdministrativeRegion | null {
    const normalized = compact(value);
    if (!normalized) return null;
    if (retired.some((name) => normalized.includes(name))) return null;

    for (const region of municipalities) {
      const candidates = [region.regionName, ...region.aliases].map(compact);
      if (candidates.some((candidate) => normalized === candidate)) return region;
    }
    for (const region of municipalities) {
      if (normalized.includes(compact(region.regionName))) return region;
    }
    if (provinceNames.some((candidate) => normalized === candidate)) {
      return province;
    }
    // A council name is the one containment match allowed at province level:
    // a document titled 경상북도의회 회의록 is provincial, but a stray mention
    // of the province inside a municipal document is not.
    if (provinceCouncilNames.some((name) => normalized.includes(name))) {
      return province;
    }
    return null;
  }

  return {
    config,
    regions,
    province,
    resolve,
    infer(...values) {
      for (const value of values) {
        if (!value) continue;
        const region = resolve(value);
        if (region) return region;
      }
      return null;
    },
    byId(regionId) {
      return regions.find((region) => region.regionId === regionId) ?? null;
    }
  };
}

export const GYEONGBUK_PROVINCE: ProvinceRegionConfig = {
  code: "47",
  name: "경상북도",
  shortNames: ["경북", "경북도"],
  // 군위군 moved to 대구광역시 in 2023; rows naming it belong to another
  // province's series and must not be folded into Gyeongbuk totals.
  retiredNames: ["군위"],
  municipalities: [
    { code: "47110", name: "포항시", type: "city" },
    { code: "47130", name: "경주시", type: "city" },
    { code: "47150", name: "김천시", type: "city" },
    { code: "47170", name: "안동시", type: "city" },
    { code: "47190", name: "구미시", type: "city" },
    { code: "47210", name: "영주시", type: "city" },
    { code: "47230", name: "영천시", type: "city" },
    { code: "47250", name: "상주시", type: "city" },
    { code: "47280", name: "문경시", type: "city" },
    { code: "47290", name: "경산시", type: "city" },
    { code: "47730", name: "의성군", type: "county" },
    { code: "47750", name: "청송군", type: "county" },
    { code: "47760", name: "영양군", type: "county" },
    { code: "47770", name: "영덕군", type: "county" },
    { code: "47820", name: "청도군", type: "county" },
    { code: "47830", name: "고령군", type: "county" },
    { code: "47840", name: "성주군", type: "county" },
    { code: "47850", name: "칠곡군", type: "county" },
    { code: "47900", name: "예천군", type: "county" },
    { code: "47920", name: "봉화군", type: "county" },
    { code: "47930", name: "울진군", type: "county" },
    { code: "47940", name: "울릉군", type: "county" }
  ]
};

/**
 * A second province, carried as a worked example rather than as loaded data.
 *
 * Its purpose is to keep the Gyeongbuk pipeline honest: any resolution rule
 * that only works because of a Gyeongbuk name fails here immediately. Adopting
 * this project elsewhere means adding a config of this shape and pointing the
 * loaders at that province's files - no change to the ETL itself.
 */
export const JEONNAM_PROVINCE: ProvinceRegionConfig = {
  code: "46",
  name: "전라남도",
  shortNames: ["전남", "전남도"],
  municipalities: [
    { code: "46110", name: "목포시", type: "city" },
    { code: "46130", name: "여수시", type: "city" },
    { code: "46150", name: "순천시", type: "city" },
    { code: "46170", name: "나주시", type: "city" },
    { code: "46230", name: "광양시", type: "city" },
    { code: "46710", name: "담양군", type: "county" },
    { code: "46720", name: "곡성군", type: "county" },
    { code: "46730", name: "구례군", type: "county" },
    { code: "46770", name: "고흥군", type: "county" },
    { code: "46780", name: "보성군", type: "county" },
    { code: "46790", name: "화순군", type: "county" },
    { code: "46810", name: "장흥군", type: "county" },
    { code: "46820", name: "강진군", type: "county" },
    { code: "46830", name: "해남군", type: "county" },
    { code: "46840", name: "영암군", type: "county" },
    { code: "46860", name: "무안군", type: "county" },
    { code: "46870", name: "함평군", type: "county" },
    { code: "46880", name: "영광군", type: "county" },
    { code: "46890", name: "장성군", type: "county" },
    { code: "46900", name: "완도군", type: "county" },
    { code: "46910", name: "진도군", type: "county" },
    { code: "46920", name: "신안군", type: "county" }
  ]
};

export const PROVINCE_CONFIGS: readonly ProvinceRegionConfig[] = [
  GYEONGBUK_PROVINCE,
  JEONNAM_PROVINCE
];

const adapters = new Map<string, RegionAdapter>(
  PROVINCE_CONFIGS.map((config) => [config.code, createRegionAdapter(config)])
);

/** Looks a province adapter up by code or by any of its names. */
export function regionAdapterFor(value: string): RegionAdapter | null {
  const direct = adapters.get(value);
  if (direct) return direct;
  const normalized = compact(value);
  for (const adapter of adapters.values()) {
    const names = [adapter.config.name, ...adapter.config.shortNames].map(compact);
    if (names.includes(normalized)) return adapter;
  }
  return null;
}

export const gyeongbukAdapter = adapters.get(GYEONGBUK_PROVINCE.code)!;
