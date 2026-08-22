import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { listDatasetIds } from "@gb/domain";
import { PostgresDataRepository } from "./postgres-repository.js";

const connectionString = process.env.TEST_DATABASE_URL;
const describeDatabase = connectionString ? describe : describe.skip;

const SOURCE_KEY = "test-catalog-coverage-source";
const REGION_A = "47990";
const REGION_B = "47991";

let repository: PostgresDataRepository | undefined;
let client: Client | undefined;

async function seed(db: Client): Promise<string> {
  await db.query(
    `INSERT INTO dim_region (region_id, region_name, region_type, normalized_name)
     VALUES ($1, '커버리지테스트시', 'city', '커버리지테스트'),
            ($2, '커버리지테스트군', 'county', '커버리지테스트군')
     ON CONFLICT (region_id) DO NOTHING`,
    [REGION_A, REGION_B]
  );
  const source = await db.query<{ source_id: string }>(
    `INSERT INTO data_source (
       source_key, title, provider, source_url, collected_at,
       is_official, file_path, media_type, file_sha256, data_status
     )
     VALUES ($1, '카탈로그 커버리지 테스트 원천', '경상북도', NULL,
             now(), true, 'datasets/test/coverage.csv', 'text/csv',
             $2, 'official_observed')
     ON CONFLICT (source_key) DO UPDATE SET title = excluded.title
     RETURNING source_id`,
    [SOURCE_KEY, "c".repeat(64)]
  );
  const sourceId = source.rows[0]!.source_id;

  await db.query(
    `INSERT INTO population_observation (
       region_id, reference_date, population_total, measurement_basis,
       reference_date_precision, source_id, data_status
     )
     VALUES ($1, DATE '2021-12-31', 500000, 'resident_registration_snapshot', 'day', $3, 'official_observed'),
            ($1, DATE '2024-12-31', 489720, 'resident_registration_snapshot', 'day', $3, 'official_observed'),
            ($2, DATE '2023-12-31', 248000, 'resident_registration_snapshot', 'day', $3, 'official_observed')
     ON CONFLICT (region_id, reference_date, source_id) DO NOTHING`,
    [REGION_A, REGION_B, sourceId]
  );
  await db.query(
    `INSERT INTO local_tax_revenue (
       region_id, fiscal_year, tax_category, revenue_amount_won,
       accounting_basis, amount_semantics, source_id, data_status
     )
     VALUES ($1, 2021, '합계', 500000000000, 'settlement', 'collected_amount', $2, 'official_observed'),
            ($1, 2024, '합계', 560000000000, 'settlement', 'collected_amount', $2, 'official_observed')
     ON CONFLICT DO NOTHING`,
    [REGION_A, sourceId]
  );
  return sourceId;
}

async function cleanup(db: Client): Promise<void> {
  await db.query(
    `DELETE FROM population_observation
      WHERE source_id IN (SELECT source_id FROM data_source WHERE source_key = $1)`,
    [SOURCE_KEY]
  );
  await db.query(
    `DELETE FROM local_tax_revenue
      WHERE source_id IN (SELECT source_id FROM data_source WHERE source_key = $1)`,
    [SOURCE_KEY]
  );
  await db.query(`DELETE FROM data_source WHERE source_key = $1`, [SOURCE_KEY]);
  await db.query(`DELETE FROM dim_region WHERE region_id = ANY($1::text[])`, [
    [REGION_A, REGION_B]
  ]);
}

describeDatabase("dataset coverage probes against Postgres", () => {
  beforeAll(async () => {
    client = new Client({ connectionString });
    await client.connect();
    await cleanup(client);
    await seed(client);
    repository = new PostgresDataRepository(client, async () => {});
  });

  afterAll(async () => {
    if (client) {
      await cleanup(client);
      await client.end();
    }
  });

  it("executes a probe for every catalogued dataset without erroring", async () => {
    // Each probe is generated SQL; this asserts all of them actually parse and
    // run against the real schema rather than only type-checking.
    const coverage = await repository!.getDatasetCoverage(listDatasetIds());
    expect(coverage).toHaveLength(listDatasetIds().length);
    for (const entry of coverage) {
      expect(
        entry.note === null || !entry.note.includes("커버리지를 측정하지 못했습니다")
      ).toBe(true);
    }
  });

  it("measures the real year range, region count and sources for population", async () => {
    const [coverage] = await repository!.getDatasetCoverage([
      "population_observation"
    ]);
    expect(coverage!.available).toBe(true);
    expect(coverage!.rowCount).toBeGreaterThanOrEqual(3);
    expect(coverage!.yearRange!.start).toBeLessThanOrEqual(2021);
    expect(coverage!.yearRange!.end).toBeGreaterThanOrEqual(2024);
    expect(coverage!.regions).toContain("커버리지테스트시");
    expect(coverage!.dataStatuses).toContain("official_observed");
    expect(coverage!.lastObservedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(coverage!.sources.length).toBeGreaterThan(0);
  });

  it("derives a year range for the tax dataset from fiscal_year", async () => {
    // fiscal_year is a plain smallint, not a date, so it needs different SQL
    // from the date-based datasets.
    const [coverage] = await repository!.getDatasetCoverage([
      "local_tax_revenue"
    ]);
    expect(coverage!.available).toBe(true);
    expect(coverage!.yearRange!.start).toBeLessThanOrEqual(2021);
    expect(coverage!.yearRange!.end).toBeGreaterThanOrEqual(2024);
    expect(coverage!.lastObservedAt).toMatch(/^\d{4}-12-31$/u);
  });

  it("caps the number of regions and sources it returns", async () => {
    const coverage = await repository!.getDatasetCoverage(listDatasetIds());
    for (const entry of coverage) {
      expect(entry.regions.length).toBeLessThanOrEqual(30);
      expect(entry.sources.length).toBeLessThanOrEqual(10);
    }
  });

  it("reports an unknown dataset as unavailable instead of throwing", async () => {
    const [coverage] = await repository!.getDatasetCoverage(["no_such_dataset"]);
    expect(coverage!.available).toBe(false);
    expect(coverage!.note).toContain("등록되지 않은");
  });
});
