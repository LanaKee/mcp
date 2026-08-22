import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { PostgresDataRepository } from "./postgres-repository.js";

const connectionString = process.env.TEST_DATABASE_URL;
const describeDatabase = connectionString ? describe : describe.skip;

const SOURCE_KEY = "test-member-bill-search-source";
const LEADER_ID = "gb-council-member-test-leader";
const SIGNER_ID = "gb-council-member-test-signer";
const LED_BILL_ID = "gb-council-bill-test-led";
const SIGNED_BILL_ID = "gb-council-bill-test-signed";

let repository: PostgresDataRepository | undefined;
let client: Client | undefined;

async function seed(db: Client): Promise<void> {
  const source = await db.query<{ source_id: string }>(
    `INSERT INTO data_source (
       source_key, title, provider, source_url, collected_at,
       is_official, file_path, media_type, file_sha256, data_status
     )
     VALUES ($1, '테스트 의안 스냅샷', '경상북도의회', 'https://council.gb.go.kr/',
             now(), true, 'datasets/test/council.csv', 'text/csv',
             $2, 'official_observed')
     ON CONFLICT (source_key) DO UPDATE SET title = excluded.title
     RETURNING source_id`,
    [SOURCE_KEY, "9".repeat(64)]
  );
  const sourceId = source.rows[0]!.source_id;

  await db.query(
    `INSERT INTO council_member (
       council_member_id, council_name, search_code, site_member_id, name,
       party, district, region_id, position, office_phone, education, career,
       photo_url, homepage_url, source_id, data_status, metadata
     )
     VALUES
       ($1, '경상북도의회', 'T0001', '9001', '테스트대표', '테스트당',
        '안동시 제9선거구', NULL, '테스트위원회 위원장', NULL, NULL,
        '(현)테스트위원회 위원장', NULL,
        'https://council.gb.go.kr/member/main?search_code=T0001', $3,
        'official_observed', '{}'::jsonb),
       ($2, '경상북도의회', 'T0002', '9002', '테스트공동', '테스트당',
        '비례대표', NULL, '테스트위원회 위원', NULL, NULL, NULL, NULL,
        'https://council.gb.go.kr/member/main?search_code=T0002', $3,
        'official_observed', '{}'::jsonb)
     ON CONFLICT (council_member_id) DO NOTHING`,
    [LEADER_ID, SIGNER_ID, sourceId]
  );

  await db.query(
    `INSERT INTO council_bill (
       council_bill_id, council_name, bill_uid, bill_number, title, bill_kind,
       proposer_kind, committee, session_name, proposed_date, decided_date,
       status, outcome, lead_sponsor_count, co_sponsor_count, detail_url,
       source_id, data_status, metadata
     )
     VALUES
       ($1, '경상북도의회', 'TESTUID0000000000000000000000001', '9001',
        '경상북도 테스트림 보호 조례안', '조례안', '의원', '테스트위원회',
        '제999회 경상북도의회 임시회', DATE '2025-05-01', DATE '2025-05-20',
        '처리완료', '원안가결', 1, 1,
        'https://council.gb.go.kr/bill-led', $3, 'official_observed',
        '{}'::jsonb),
       ($2, '경상북도의회', 'TESTUID0000000000000000000000002', '9002',
        '경상북도 테스트림 폐기 조례안', '조례안', '의원', '테스트위원회',
        '제999회 경상북도의회 임시회', DATE '2024-05-01', NULL,
        '처리완료', '폐기', 1, 1,
        'https://council.gb.go.kr/bill-signed', $3, 'official_observed',
        '{}'::jsonb)
     ON CONFLICT (council_bill_id) DO NOTHING`,
    [LED_BILL_ID, SIGNED_BILL_ID, sourceId]
  );

  await db.query(
    `INSERT INTO council_bill_sponsor (council_bill_id, role, member_name, council_member_id)
     VALUES
       ($1, 'lead', '테스트대표', $3),
       ($1, 'co', '테스트공동', $4),
       ($2, 'lead', '테스트공동', $4),
       ($2, 'co', '테스트대표', $3),
       ($2, 'co', '테스트전임', NULL)
     ON CONFLICT DO NOTHING`,
    [LED_BILL_ID, SIGNED_BILL_ID, LEADER_ID, SIGNER_ID]
  );
}

async function cleanup(db: Client): Promise<void> {
  await db.query("DELETE FROM council_bill_sponsor WHERE council_bill_id = ANY($1)", [
    [LED_BILL_ID, SIGNED_BILL_ID]
  ]);
  await db.query("DELETE FROM council_bill WHERE council_bill_id = ANY($1)", [
    [LED_BILL_ID, SIGNED_BILL_ID]
  ]);
  await db.query("DELETE FROM council_member WHERE council_member_id = ANY($1)", [
    [LEADER_ID, SIGNER_ID]
  ]);
  await db.query("DELETE FROM data_source WHERE source_key = $1", [SOURCE_KEY]);
}

describeDatabase("member bill search", () => {
  beforeAll(async () => {
    repository = PostgresDataRepository.fromConnectionString(connectionString!);
    client = new Client({ connectionString });
    await client.connect();
    await cleanup(client);
    await seed(client);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await cleanup(client).catch(() => undefined);
      await client.end();
    }
    await repository?.close();
  });

  it("returns a member's bills with their sponsorship role and provenance", async () => {
    const found = await repository!.searchMemberBills({
      member: "테스트대표",
      role: "any",
      limit: 20
    });
    const ids = found.records.map((row) => row.id);
    expect(ids).toContain(LED_BILL_ID);
    expect(ids).toContain(SIGNED_BILL_ID);
    const led = found.records.find((row) => row.id === LED_BILL_ID)!;
    expect(led.metadata).toMatchObject({
      councilName: "경상북도의회",
      billKind: "조례안",
      committee: "테스트위원회",
      proposedDate: "2025-05-01",
      outcome: "원안가결",
      recordType: "council_bill",
      evidenceRole: "narrative_context_only"
    });
    expect(led.metadata.leadSponsors).toContain("테스트대표");
    expect(found.sources.some((source) => source.sourceId === SOURCE_KEY)).toBe(true);
  });

  it("does not credit a co-signed bill as one the member led", async () => {
    const led = await repository!.searchMemberBills({
      member: "테스트대표",
      role: "lead",
      limit: 20
    });
    const ids = led.records.map((row) => row.id);
    expect(ids).toContain(LED_BILL_ID);
    // 테스트대표 only co-signed the second bill; asking for 대표발의 must not
    // return it, or the member looks twice as productive as they are.
    expect(ids).not.toContain(SIGNED_BILL_ID);
    expect(led.records[0]?.metadata.memberRoles).toEqual(["lead"]);
  });

  it("reports the roster summary so an ambiguous name is visible", async () => {
    const found = await repository!.searchMemberBills({
      member: "테스트대표",
      role: "any",
      limit: 5
    });
    const member = found.members.find((row) => row.name === "테스트대표");
    expect(member).toBeDefined();
    expect(member!.leadBillCount).toBe(1);
    expect(member!.coBillCount).toBe(1);
    expect(member!.district).toBe("안동시 제9선거구");
  });

  it("returns nothing rather than the whole council when the member is unknown", async () => {
    const found = await repository!.searchMemberBills({
      member: "존재하지않는의원이름",
      role: "any",
      limit: 5
    });
    expect(found.records).toEqual([]);
    expect(found.members).toEqual([]);
  });

  it("matches a Hangul bill title and honours the outcome filter", async () => {
    const passed = await repository!.searchMemberBills({
      query: "테스트림",
      outcome: "원안가결",
      role: "any",
      limit: 20
    });
    expect(passed.records.map((row) => row.id)).toContain(LED_BILL_ID);
    expect(passed.records.map((row) => row.id)).not.toContain(SIGNED_BILL_ID);

    const discarded = await repository!.searchMemberBills({
      query: "테스트림",
      outcome: "폐기",
      role: "any",
      limit: 20
    });
    expect(discarded.records.map((row) => row.id)).toContain(SIGNED_BILL_ID);
  });

  it("honours the proposal date window", async () => {
    const recent = await repository!.searchMemberBills({
      member: "테스트대표",
      role: "any",
      dateFrom: "2025-01-01",
      limit: 20
    });
    expect(recent.records.map((row) => row.id)).toEqual([LED_BILL_ID]);
  });
});
