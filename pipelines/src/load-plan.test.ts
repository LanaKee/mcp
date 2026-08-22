import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "./catalog.js";
import type { EtlResult } from "./etl.js";
import {
  createLoadPlan,
  deterministicCouncilId,
  officialSourceKey
} from "./load-plan.js";

const sourcePath = "datasets/경상북도_경북도의회_안건_20260716.csv";
const sourceSha256 = "a".repeat(64);

function catalogEntry(): CatalogEntry {
  return {
    path: sourcePath,
    fileNameNfc: "경상북도_경북도의회_안건_20260716.csv",
    extension: ".csv",
    byteSize: 100,
    sha256: sourceSha256,
    collectedAt: "2026-07-16T00:00:00.000Z",
    referenceDate: "2026-07-16",
    mediaType: "text/csv",
    contentKind: "council_agenda",
    encoding: "utf8",
    dataStatus: "official_observed",
    parseStatus: "parsed",
    error: null
  };
}

function fixture(): EtlResult {
  return {
    catalog: [catalogEntry()],
    population: [
      {
        regionName: "경상북도",
        referenceDate: "2026-06-30",
        populationTotal: 2_500_000,
        populationMale: null,
        populationFemale: null,
        householdCount: null,
        foreignPopulation: null,
        sourceRow: 2,
        sourcePath,
        sourceSha256,
        dataStatus: "official_observed"
      },
      {
        regionName: "경상북도",
        referenceDate: "2026-07-31",
        populationTotal: 2_490_000,
        populationMale: null,
        populationFemale: null,
        householdCount: null,
        foreignPopulation: null,
        sourceRow: 3,
        sourcePath,
        sourceSha256,
        dataStatus: "official_observed"
      }
    ],
    council: [
      {
        regionName: "경상북도",
        title: "청년 지원 조례안",
        recordNumber: "42",
        proposer: "도의원",
        councilName: "경상북도의회",
        sessionName: "제1회",
        meetingDate: "2026-07-01",
        result: "가결",
        sourceRecordId: "",
        detailUrl: "",
        dataQualityIssues: [],
        sourceRow: 4,
        sourcePath,
        sourceSha256,
        dataStatus: "official_observed"
      }
    ],
    errors: []
  };
}

describe("database load plan", () => {
  it("keeps exact monthly population dates as distinct natural keys", async () => {
    const plan = await createLoadPlan(fixture(), { includeDemo: false });
    expect(plan.population.map((row) => row.referenceDate)).toEqual([
      "2026-06-30",
      "2026-07-31"
    ]);
    expect(new Set(plan.population.map((row) => row.referenceDate)).size).toBe(2);
  });

  it("uses stable source-version keys and deterministic council IDs", async () => {
    const first = await createLoadPlan(fixture(), { includeDemo: false });
    const second = await createLoadPlan(fixture(), { includeDemo: false });
    expect(first.inputSha256).toBe(second.inputSha256);
    expect(first.council[0]?.councilRecordId).toBe(
      second.council[0]?.councilRecordId
    );
    expect(first.sources[0]?.sourceKey).toBe(
      officialSourceKey(sourcePath, sourceSha256)
    );
    expect(
      deterministicCouncilId({
        sourcePath,
        sourceSha256: "b".repeat(64),
        sourceRow: 4,
        recordNumber: "42"
      })
    ).not.toBe(first.council[0]?.councilRecordId);
    expect(
      deterministicCouncilId({
        sourcePath,
        sourceSha256,
        sourceRow: 4,
        recordNumber: "42",
        stableSourceRecordId: "3336"
      })
    ).toBe(
      deterministicCouncilId({
        sourcePath,
        sourceSha256: "b".repeat(64),
        sourceRow: 9,
        recordNumber: "",
        stableSourceRecordId: "3336"
      })
    );
  });

  it("preserves the official Pohang council page as dataset provenance", async () => {
    const etl = fixture();
    const pohangPath = "datasets/pohang-council/경상북도_포항시_의회_의안정보.csv";
    etl.catalog[0] = {
      ...etl.catalog[0]!,
      path: pohangPath,
      fileNameNfc: "경상북도_포항시_의회_의안정보.csv"
    };
    etl.council[0] = {
      ...etl.council[0]!,
      regionName: "포항시",
      councilName: "포항시의회",
      sourcePath: pohangPath,
      sourceRecordId: "3336",
      detailUrl:
        "https://council.pohang.go.kr/content/activity/bill.html?number=3336",
      dataQualityIssues: [
        {
          field: "transferDate",
          issueCode: "source_year_transposition"
        }
      ]
    };
    const plan = await createLoadPlan(etl, { includeDemo: false });
    expect(plan.sources[0]).toMatchObject({
      provider: "포항시의회",
      sourceUrl: "https://council.pohang.go.kr/content/activity/billSearch.html"
    });
    expect(plan.council[0]?.metadata).toMatchObject({
      sourceRecordId: "3336",
      dataQualityIssues: [
        {
          issueCode: "source_year_transposition"
        }
      ]
    });
  });

  it("rejects unresolved factual rows instead of inventing region IDs", async () => {
    const etl = fixture();
    etl.population[0]!.regionName = "임의지역";
    const plan = await createLoadPlan(etl, { includeDemo: false });
    expect(plan.population).toHaveLength(1);
    expect(plan.rejected[0]).toMatchObject({
      entityType: "population_observation",
      sourceRow: 2
    });
  });
});
