import { describe, expect, it } from "vitest";
import {
  normalizeAnnualPopulation,
  normalizePopulationSnapshot,
  parseKoreanCsv
} from "./csv.js";
import {
  createRegionAdapter,
  GYEONGBUK_PROVINCE,
  JEONNAM_PROVINCE,
  gyeongbukAdapter,
  regionAdapterFor
} from "./region-adapter.js";
import { resolveGyeongbukRegion } from "./regions.js";

const jeonnam = createRegionAdapter(JEONNAM_PROVINCE);

describe("province region adapter", () => {
  it("resolves a municipality it was never hand-coded for", () => {
    expect(jeonnam.resolve("고흥군")?.regionId).toBe("46770");
    expect(jeonnam.resolve("고흥")?.regionName).toBe("고흥군");
    expect(jeonnam.resolve("2024년_순천시_인구현황.csv")?.regionName).toBe(
      "순천시"
    );
  });

  it("derives council aliases from the name rather than a list", () => {
    expect(jeonnam.resolve("여수시의회")?.regionName).toBe("여수시");
    expect(jeonnam.resolve("전라남도의회 회의록")?.regionType).toBe("province");
    expect(gyeongbukAdapter.resolve("봉화군의회")?.regionName).toBe("봉화군");
  });

  it("keeps provinces from claiming each other's regions", () => {
    // The point of the adapter: a name only resolves inside the province that
    // actually administers it, so a misrouted file yields nothing instead of a
    // plausible-looking wrong region.
    expect(gyeongbukAdapter.resolve("고흥군")).toBeNull();
    expect(jeonnam.resolve("봉화군")).toBeNull();
  });

  it("refuses a municipality that left the province", () => {
    expect(gyeongbukAdapter.resolve("군위군")).toBeNull();
  });

  it("keeps the Gyeongbuk facade identical to the adapter", () => {
    for (const region of gyeongbukAdapter.regions) {
      expect(resolveGyeongbukRegion(region.regionName)).toEqual(region);
    }
    expect(regionAdapterFor("전남")).toBe(regionAdapterFor("46"));
    expect(regionAdapterFor(GYEONGBUK_PROVINCE.name)?.config.code).toBe("47");
    expect(regionAdapterFor("서울특별시")).toBeNull();
  });
});

describe("loading another province through the same ETL", () => {
  it("normalises a Jeonnam monthly population file unchanged", () => {
    const csv = [
      "년월,세대수,한국인남,한국인여,외국인남,외국인여",
      "2024-03,31200,33100,34980,410,260"
    ].join("\n");
    const decoded = parseKoreanCsv(Buffer.from(csv, "utf8"));
    const rows = normalizeAnnualPopulation(
      decoded,
      "2024_고흥군_인구현황.csv",
      jeonnam
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      regionName: "고흥군",
      referenceDate: "2024-03-01",
      populationTotal: 68750,
      foreignPopulation: 670,
      householdCount: 31200,
      measurementBasis: "resident_registration_snapshot",
      referenceDatePrecision: "month"
    });
  });

  it("normalises a Jeonnam municipality summary table unchanged", () => {
    const csv = ["시군별,인구,세대수", "목포시,213500,101200", "여수시,272400,127300"].join(
      "\n"
    );
    const decoded = parseKoreanCsv(Buffer.from(csv, "utf8"));
    const rows = normalizePopulationSnapshot(
      decoded,
      "전라남도_시군별_인구.csv",
      "2024-12-31",
      jeonnam
    );

    expect(rows.map((row) => row.regionName)).toEqual(["목포시", "여수시"]);
    expect(rows[0]?.populationTotal).toBe(213500);
    expect(rows[0]?.referenceDate).toBe("2024-12-31");
  });

  it("drops the same file when it is read as Gyeongbuk", () => {
    // Portability must not become leakage: without the right adapter the rows
    // are rejected rather than attributed to whatever region happens to match.
    const csv = ["시군별,인구,세대수", "목포시,213500,101200"].join("\n");
    const decoded = parseKoreanCsv(Buffer.from(csv, "utf8"));
    expect(
      normalizePopulationSnapshot(decoded, "전라남도_시군별_인구.csv", "2024-12-31")
    ).toEqual([]);
  });
});
