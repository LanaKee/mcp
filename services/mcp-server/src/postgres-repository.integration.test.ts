import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
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

  it("persists an HTTP-safe audit correlation ID", async () => {
    const correlationId = `itest-${Date.now()}`;
    await repository!.writeAudit({
      toolName: "integration_test",
      startedAt: new Date(),
      finishedAt: new Date(),
      success: true,
      dataStatuses: ["official_observed"],
      resultCount: 1,
      requestHash: "b".repeat(64),
      requestMetadata: { keys: [] },
      correlationId,
      errorClass: null
    });
    const pool = new Pool({ connectionString, max: 1 });
    try {
      const result = await pool.query<{
        correlation_id: string;
        request_metadata: Record<string, unknown>;
      }>(
        `SELECT correlation_id, request_metadata
         FROM mcp_tool_audit
         WHERE correlation_id = $1
         ORDER BY audit_id DESC
         LIMIT 1`,
        [correlationId]
      );
      expect(result.rows[0]).toMatchObject({
        correlation_id: correlationId,
        request_metadata: { keys: [] }
      });
    } finally {
      await pool
        .query("DELETE FROM mcp_tool_audit WHERE correlation_id = $1", [
          correlationId
        ])
        .catch(() => undefined);
      await pool.end();
    }
  });
});
