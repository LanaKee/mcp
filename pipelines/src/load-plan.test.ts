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
        measurementBasis: "resident_registration_snapshot",
        referenceDatePrecision: "month",
        metadata: {},
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
        measurementBasis: "resident_registration_snapshot",
        referenceDatePrecision: "month",
        metadata: {},
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
    pressRelease: [
      {
        sourceRecordId: "128744",
        title: "경상북도, 청도군 청년 창업 지원 확대",
        body: "경상북도는 청도군과 함께 청년 창업 지원을 확대한다고 밝혔다.",
        bodySha256: "c".repeat(64),
        provinceName: "경상북도",
        department: "메타버스과",
        contactPhone: "054-880-1234",
        author: "홍길동",
        subheadings: ["도내 청년 500명 대상"],
        attachmentNames: ["보도자료.hwp"],
        publishedDate: "2026-07-02",
        publishedAt: "2026-07-02T09:30:00",
        viewCount: 1234,
        detailUrl: "https://www.gb.go.kr/detail",
        sourceRow: 5,
        sourcePath,
        sourceSha256,
        dataStatus: "official_observed"
      }
    ],
    errors: []
  };
}

describe("press release planning", () => {
  it("keys press releases on the board post id, not the snapshot file", async () => {
    const etl = fixture();
    const plan = await createLoadPlan(etl);
    expect(plan.pressReleases).toHaveLength(1);
    expect(plan.pressReleases[0]?.pressReleaseId).toBe("gb-press-128744");

    // A later crawl writes a different file, so the source key changes. The
    // announcement must still resolve to one row instead of accumulating a copy.
    const recrawledSha = "d".repeat(64);
    const recrawled = fixture();
    recrawled.catalog = [{ ...catalogEntry(), sha256: recrawledSha }];
    recrawled.population = [];
    recrawled.council = [];
    recrawled.pressRelease = recrawled.pressRelease.map((row) => ({
      ...row,
      sourceSha256: recrawledSha,
      viewCount: 5000
    }));
    const second = await createLoadPlan(recrawled);
    expect(second.pressReleases[0]?.pressReleaseId).toBe("gb-press-128744");
    expect(second.pressReleases[0]?.sourceKey).not.toBe(
      plan.pressReleases[0]?.sourceKey
    );
  });

  it("records mentioned municipalities without claiming ownership", async () => {
    const plan = await createLoadPlan(fixture());
    const row = plan.pressReleases[0]!;
    expect(row.regionId).toBe("47");
    expect(row.mentionedRegionIds).toEqual(["47820"]);
    expect(row.metadata).toMatchObject({
      evidenceRole: "narrative_context_only",
      recordType: "press_release"
    });
  });

  it("marks press releases as narrative context rather than a measurement", async () => {
    const plan = await createLoadPlan(fixture());
    const row = plan.pressReleases[0]!;
    expect(row.dataStatus).toBe("official_observed");
    expect(row.contentClassification).toBe("extracted_ok");
    expect(row.bodyCharCount).toBe(row.body.length);
    expect(
      plan.locators.some(
        (locator) =>
          locator.entityType === "press_release" &&
          locator.entityKey === "gb-press-128744"
      )
    ).toBe(true);
  });

  it("flags an unreadable body instead of indexing it as context", async () => {
    const etl = fixture();
    etl.pressRelease[0]!.body = "\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD";
    const plan = await createLoadPlan(etl);
    expect(plan.pressReleases[0]?.contentClassification).toBe(
      "mojibake_suspected"
    );
  });
});

describe("database load plan", () => {
  it("keeps exact monthly population dates as distinct natural keys", async () => {
    const plan = await createLoadPlan(fixture());
    expect(plan.population.map((row) => row.referenceDate)).toEqual([
      "2026-06-30",
      "2026-07-31"
    ]);
    expect(new Set(plan.population.map((row) => row.referenceDate)).size).toBe(2);
  });

  it("collapses identical bytes at two paths into a single source", async () => {
    const etl = fixture();
    const copyPath = "datasets/local-tax/복사본_안건_20260716.csv";
    etl.catalog.push({ ...catalogEntry(), path: copyPath });
    etl.population.push(
      ...etl.population.map((row) => ({ ...row, sourcePath: copyPath }))
    );

    const plan = await createLoadPlan(etl);

    expect(plan.sources).toHaveLength(1);
    expect(plan.sources[0]?.sourceKey).toBe(officialSourceKey(sourceSha256));
    // Facts are keyed by (source_id, source_row), so a forked source key used to
    // duplicate every row it carried.
    expect(plan.population).toHaveLength(2);
    expect(
      new Set(plan.population.map((row) => `${row.sourceKey}:${row.sourceRow}`))
        .size
    ).toBe(2);
  });

  it("uses stable source-version keys and deterministic council IDs", async () => {
    const first = await createLoadPlan(fixture());
    const second = await createLoadPlan(fixture());
    expect(first.inputSha256).toBe(second.inputSha256);
    expect(first.council[0]?.councilRecordId).toBe(
      second.council[0]?.councilRecordId
    );
    expect(first.sources[0]?.sourceKey).toBe(
      officialSourceKey(sourceSha256)
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
    const plan = await createLoadPlan(etl);
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
    const plan = await createLoadPlan(etl);
    expect(plan.population).toHaveLength(1);
    expect(plan.rejected[0]).toMatchObject({
      entityType: "population_observation",
      sourceRow: 2
    });
  });
});
