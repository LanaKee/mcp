import { describe, expect, it } from "vitest";
import {
  GYEONGBUK_REGIONS,
  inferGyeongbukRegion,
  resolveGyeongbukRegion
} from "./regions.js";

describe("canonical Gyeongbuk regions", () => {
  it("contains the province and every current municipality without Gunwi", () => {
    expect(GYEONGBUK_REGIONS[0]?.regionName).toBe("경상북도");
    expect(GYEONGBUK_REGIONS.map((region) => region.regionName)).not.toContain("군위군");
    expect(GYEONGBUK_REGIONS.map((region) => region.regionName)).toEqual(
      expect.arrayContaining(["포항시", "경산시", "의성군", "울릉군"])
    );
  });

  it("resolves council aliases and municipality paths", () => {
    expect(resolveGyeongbukRegion("경북도의회")?.regionId).toBe("47");
    expect(
      inferGyeongbukRegion("datasets/경상북도_칠곡군_의회 의안 처리 정보.csv")
        ?.regionId
    ).toBe("47850");
  });

  it("rejects transferred or genuinely unknown regions", () => {
    expect(resolveGyeongbukRegion("군위군")).toBeNull();
    expect(resolveGyeongbukRegion("임의지역")).toBeNull();
    expect(resolveGyeongbukRegion("경상북도_임의군_의안.csv")).toBeNull();
  });
});
