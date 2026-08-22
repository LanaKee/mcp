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
    councilMember: [],
    councilBill: [],
    councilBillSponsor: [],
    errors: []
  };
}

const councilSourcePath = "datasets/gyeongbuk-council/경상북도의회_의안.csv";
const councilSha256 = "e".repeat(64);

function councilFixture(): EtlResult {
  const etl = fixture();
  etl.catalog = [
    {
      ...catalogEntry(),
      path: councilSourcePath,
      fileNameNfc: "경상북도의회_의안.csv",
      sha256: councilSha256,
      contentKind: "council_bill"
    }
  ];
  etl.population = [];
  etl.council = [];
  etl.pressRelease = [];
  etl.councilMember = [
    {
      searchCode: "12009",
      siteMemberId: "852",
      name: "김대진",
      party: "국민의힘",
      district: "안동시 제1선거구",
      position: "문화환경위원회 위원장",
      officePhone: "054-880-5360",
      education: "안동대학교 졸업",
      career: "(전)안동시의회 의원",
      photoUrl: null,
      homepageUrl: "https://council.gb.go.kr/member/main?search_code=12009",
      sourceRow: 2,
      sourcePath: councilSourcePath,
      sourceSha256: councilSha256,
      dataStatus: "official_observed"
    },
    {
      searchCode: "13640",
      siteMemberId: "897",
      name: "공승희",
      party: "국민의힘",
      district: "비례대표",
      position: "문화환경위원회 위원",
      officePhone: null,
      education: null,
      career: null,
      photoUrl: null,
      homepageUrl: "https://council.gb.go.kr/member/main?search_code=13640",
      sourceRow: 3,
      sourcePath: councilSourcePath,
      sourceSha256: councilSha256,
      dataStatus: "official_observed"
    }
  ];
  etl.councilBill = [
    {
      billUid: "AA11BB22CC33DD44EE55FF6677889900",
      billNumber: "1327",
      title: "경상북도 산림의 공익기능 증진에 관한 조례안",
      billKind: "조례안",
      proposerKind: "의원",
      committee: "농수산위원회",
      sessionName: "제360회 경상북도의회 정례회",
      proposedDate: "2026-03-11",
      decidedDate: "2026-03-20",
      status: "처리완료",
      outcome: "원안가결",
      leadSponsors: ["김대진"],
      coSponsorCount: 2,
      detailUrl: "https://council.gb.go.kr/member/bill/contents?reform=view",
      sourceRow: 2,
      sourcePath: councilSourcePath,
      sourceSha256: councilSha256,
      dataStatus: "official_observed"
    }
  ];
  etl.councilBillSponsor = [
    {
      billUid: "AA11BB22CC33DD44EE55FF6677889900",
      role: "lead",
      memberName: "김대진",
      searchCode: "12009",
      sourceRow: 2,
      sourcePath: councilSourcePath,
      sourceSha256: councilSha256
    },
    {
      billUid: "AA11BB22CC33DD44EE55FF6677889900",
      role: "co",
      memberName: "공승희",
      searchCode: null,
      sourceRow: 3,
      sourcePath: councilSourcePath,
      sourceSha256: councilSha256
    },
    {
      billUid: "AA11BB22CC33DD44EE55FF6677889900",
      role: "co",
      memberName: "박전임",
      searchCode: null,
      sourceRow: 4,
      sourcePath: councilSourcePath,
      sourceSha256: councilSha256
    }
  ];
  return etl;
}

describe("council member and bill planning", () => {
  it("keys members and bills on the site's own identifiers", async () => {
    const plan = await createLoadPlan(councilFixture());
    expect(plan.councilMembers.map((row) => row.councilMemberId)).toEqual([
      "gb-council-member-12009",
      "gb-council-member-13640"
    ]);
    expect(plan.councilBills[0]?.councilBillId).toBe(
      "gb-council-bill-aa11bb22cc33dd44ee55ff6677889900"
    );
    expect(plan.councilBills[0]?.leadSponsorCount).toBe(1);
  });

  it("resolves a district to its city but leaves 비례대표 unmapped", async () => {
    const plan = await createLoadPlan(councilFixture());
    const byName = new Map(plan.councilMembers.map((row) => [row.name, row]));
    expect(byName.get("김대진")?.regionId).toBe("47170");
    // A proportional-representation seat has no geography; inventing one would
    // make the member look like they represent a city they do not.
    expect(byName.get("공승희")?.regionId).toBeNull();
  });

  it("keeps 대표발의 and 공동발의 as separate rows", async () => {
    const plan = await createLoadPlan(councilFixture());
    const roles = plan.councilBillSponsors.map((row) => [row.role, row.memberName]);
    expect(roles).toEqual([
      ["lead", "김대진"],
      ["co", "공승희"],
      ["co", "박전임"]
    ]);
  });

  it("keeps a sponsor who is not on the roster instead of dropping the link", async () => {
    const plan = await createLoadPlan(councilFixture());
    const byName = new Map(
      plan.councilBillSponsors.map((row) => [row.memberName, row])
    );
    expect(byName.get("김대진")?.councilMemberId).toBe("gb-council-member-12009");
    // Matched by name even though the CSV carried no search_code.
    expect(byName.get("공승희")?.councilMemberId).toBe("gb-council-member-13640");
    // A past-term member keeps their name with a null member id.
    expect(byName.get("박전임")?.councilMemberId).toBeNull();
    expect(plan.rejected.filter((row) => row.entityType.startsWith("council_"))).toEqual(
      []
    );
  });

  it("rejects a sponsor row whose bill was never planned", async () => {
    const etl = councilFixture();
    etl.councilBillSponsor.push({
      billUid: "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
      role: "lead",
      memberName: "김대진",
      searchCode: "12009",
      sourceRow: 9,
      sourcePath: councilSourcePath,
      sourceSha256: councilSha256
    });
    const plan = await createLoadPlan(etl);
    expect(
      plan.rejected.some(
        (row) =>
          row.entityType === "council_bill_sponsor" &&
          row.reason.includes("unknown bill")
      )
    ).toBe(true);
  });

  it("emits a locator for every planned member and bill", async () => {
    const plan = await createLoadPlan(councilFixture());
    const entityTypes = plan.locators.map((row) => row.entityType);
    expect(entityTypes).toContain("council_member");
    expect(entityTypes).toContain("council_bill");
  });
});

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

  it("treats an unsalvageable HTML document as unusable rather than mojibake", async () => {
    // Some 2020 posts contain a whole HWP-exported HTML document pasted as
    // escaped source. The text is intact; it just is not prose.
    const etl = fixture();
    etl.pressRelease[0]!.body = [
      "!DOCTYPE HTML PUBLIC -//W3C//DTD HTML 4.01 Transitional//EN",
      "HTML",
      "HEAD",
      "NAME=Generator CONTENT=Hancom HWP 9.1.1.4504",
      "HTTP-EQUIV=Content-Type CONTENT=text/html; charset=utf-8",
      "STYLE type=text/css",
      "p.HStyle0 {style-name:바탕글; font-family:함초롬바탕;}"
    ].join("\n");
    const plan = await createLoadPlan(etl);
    expect(plan.pressReleases[0]?.contentClassification).toBe(
      "unusable_for_retrieval"
    );
  });

  it("keeps a body whose markup was recovered as ordinary prose", async () => {
    // Guards the negative class: an over-eager markup detector once suppressed
    // 400 perfectly readable releases.
    const etl = fixture();
    etl.pressRelease[0]!.body = [
      "제 목",
      "① 경북도, 청년 일자리 사업 추진",
      "- 3개 분야 11개 사업에 191억원 투입",
      "청년정책관"
    ].join("\n");
    const plan = await createLoadPlan(etl);
    expect(plan.pressReleases[0]?.contentClassification).toBe("extracted_ok");
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
