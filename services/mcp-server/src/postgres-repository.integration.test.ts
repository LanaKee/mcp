import { afterAll, describe, expect, it } from "vitest";
import { PostgresDataRepository } from "./postgres-repository.js";

const connectionString = process.env.TEST_DATABASE_URL;
const describeDatabase = connectionString ? describe : describe.skip;
let repository: PostgresDataRepository | undefined;

describeDatabase("PostgresDataRepository integration", () => {
  repository = PostgresDataRepository.fromConnectionString(connectionString!);

  afterAll(async () => {
    await repository?.close();
  });

  it("reads normalized facts and current PDF chunks", async () => {
    expect(await repository!.readiness()).toMatchObject({
      ready: true,
      mode: "postgres"
    });
    const population = await repository!.getPopulationTrend({
      startYear: 2024,
      endYear: 2026,
      dataStatuses: ["official_observed"]
    });
    expect(population.records.length).toBeGreaterThan(0);

    const documents = await repository!.searchDocuments({
      query: "지방소멸",
      limit: 3,
      dataStatuses: ["official_observed"]
    });
    expect(documents.records.length).toBeGreaterThan(0);
    expect(documents.records[0]!.metadata.pageStart).toBeGreaterThan(0);
  });
});
