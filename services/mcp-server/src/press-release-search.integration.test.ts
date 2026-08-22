import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { PostgresDataRepository } from "./postgres-repository.js";

const connectionString = process.env.TEST_DATABASE_URL;
const describeDatabase = connectionString ? describe : describe.skip;

const SOURCE_KEY = "test-press-release-search-source";
const READABLE_ID = "gb-press-test-readable";
const MOJIBAKE_ID = "gb-press-test-mojibake";

let repository: PostgresDataRepository | undefined;
let client: Client | undefined;

async function seed(db: Client): Promise<void> {
  const source = await db.query<{ source_id: string }>(
    `INSERT INTO data_source (
       source_key, title, provider, source_url, collected_at,
       is_official, file_path, media_type, file_sha256, data_status
     )
     VALUES ($1, '테스트 보도자료 스냅샷', '경상북도', 'https://www.gb.go.kr/',
             now(), true, 'datasets/test/press.csv', 'text/csv',
             $2, 'official_observed')
     ON CONFLICT (source_key) DO UPDATE SET title = excluded.title
     RETURNING source_id`,
    [SOURCE_KEY, "e".repeat(64)]
  );
  const sourceId = source.rows[0]!.source_id;
  await db.query(
    `INSERT INTO press_release (
       press_release_id, region_id, mentioned_region_ids, issuing_organization,
       department, contact_phone, author, title, body, body_sha256,
       body_char_count, published_date, published_at, view_count,
       attachment_count, detail_url, source_record_id, source_id,
       data_status, content_classification, metadata
     )
     VALUES
       ($1, '47', ARRAY['47820'], '경상북도', '메타버스과', '054-880-1234',
        '홍길동', '경상북도, 청도군 청년 창업 지원 확대',
        '경상북도는 청도군과 함께 청년 창업 지원 사업을 확대한다고 밝혔다.',
        $3, 44, DATE '2026-07-02', TIMESTAMPTZ '2026-07-02 09:30:00+09',
        1234, 1, 'https://www.gb.go.kr/detail-readable', 'test-readable', $5,
        'official_observed', 'extracted_ok',
        '{"recordType":"press_release","evidenceRole":"narrative_context_only"}'::jsonb),
       ($2, '47', ARRAY[]::text[], '경상북도', '메타버스과', NULL, NULL,
        '청년 창업 깨진 본문', '?????????', $4, 9,
        DATE '2026-07-03', NULL, NULL, 0,
        'https://www.gb.go.kr/detail-mojibake', 'test-mojibake', $5,
        'official_observed', 'mojibake_suspected', '{}'::jsonb)
     ON CONFLICT (press_release_id) DO NOTHING`,
    [READABLE_ID, MOJIBAKE_ID, "f".repeat(64), "0".repeat(64), sourceId]
  );
}

async function cleanup(db: Client): Promise<void> {
  await db.query("DELETE FROM press_release WHERE press_release_id = ANY($1)", [
    [READABLE_ID, MOJIBAKE_ID]
  ]);
  await db.query("DELETE FROM source_locator WHERE entity_key = ANY($1)", [
    [READABLE_ID, MOJIBAKE_ID]
  ]);
  await db.query("DELETE FROM data_source WHERE source_key = $1", [SOURCE_KEY]);
}

describeDatabase("press release search", () => {
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

  it("finds a release by a Hangul phrase and reports its provenance", async () => {
    const found = await repository!.searchPressReleases({
      query: "청년 창업",
      limit: 5
    });
    const hit = found.records.find((row) => row.id === READABLE_ID);
    expect(hit).toBeDefined();
    expect(hit!.metadata).toMatchObject({
      recordType: "press_release",
      evidenceRole: "narrative_context_only",
      organization: "경상북도",
      department: "메타버스과",
      publishedDate: "2026-07-02",
      detailUrl: "https://www.gb.go.kr/detail-readable",
      attachmentCount: 1,
      mentionedRegions: ["청도군"]
    });
    expect(hit!.matchedTerms.length).toBeGreaterThan(0);
    expect(found.sources.some((source) => source.sourceId === SOURCE_KEY)).toBe(
      true
    );
  });

  it("never returns a release whose body could not be read", async () => {
    const found = await repository!.searchPressReleases({
      query: "청년 창업",
      limit: 20
    });
    expect(found.records.some((row) => row.id === MOJIBAKE_ID)).toBe(false);
  });

  it("matches on a mentioned municipality even though the issuer is the province", async () => {
    const found = await repository!.searchPressReleases({
      query: "창업",
      region: "청도군",
      limit: 5
    });
    expect(found.records.map((row) => row.id)).toContain(READABLE_ID);

    const other = await repository!.searchPressReleases({
      query: "창업",
      region: "울릉군",
      limit: 5
    });
    expect(other.records.map((row) => row.id)).not.toContain(READABLE_ID);
  });

  it("applies department and date filters", async () => {
    const matched = await repository!.searchPressReleases({
      query: "창업",
      department: "메타버스",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-02",
      limit: 5
    });
    expect(matched.records.map((row) => row.id)).toContain(READABLE_ID);

    const excluded = await repository!.searchPressReleases({
      query: "창업",
      dateFrom: "2026-07-03",
      limit: 5
    });
    expect(excluded.records.map((row) => row.id)).not.toContain(READABLE_ID);
  });
});
