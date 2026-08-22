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

  it("persists current page quality and page source provenance", async () => {
    const pool = new Pool({ connectionString, max: 1 });
    try {
      const result = await pool.query<{
        page_number: number;
        raw_content_sha256: string;
        content_sha256: string;
        speaker_marker_count: number;
        repeated_header_line_count: number;
        locator_page: number;
      }>(
        `SELECT page.page_number,
                page.raw_content_sha256,
                page.content_sha256,
                page.speaker_marker_count,
                page.repeated_header_line_count,
                locator.page_number AS locator_page
           FROM document_page page
           JOIN document document_row
             ON document_row.document_id = page.document_id
           JOIN data_source source
             ON source.source_id = document_row.source_id
           JOIN source_locator locator
             ON locator.source_id = source.source_id
            AND locator.entity_type = 'document_page'
            AND locator.entity_key = page.page_key
          WHERE source.file_path = $1
            AND page.page_number = $2
            AND page.is_current
          LIMIT 1`,
        [
          "datasets/경상북도 김천시_의회 회의록_20231226/226회/제226회 김천시의회 본회의 2차(20220209).pdf",
          2
        ]
      );
      expect(result.rows[0]).toMatchObject({
        page_number: 2,
        locator_page: 2
      });
      expect(result.rows[0]!.raw_content_sha256).toHaveLength(64);
      expect(result.rows[0]!.content_sha256).toHaveLength(64);
      expect(result.rows[0]!.speaker_marker_count).toBeGreaterThanOrEqual(20);
      expect(result.rows[0]!.repeated_header_line_count).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("excludes stale chunk locators from source context", async () => {
    const pool = new Pool({ connectionString, max: 1 });
    try {
      const stale = await pool.query<{
        source_key: string;
        chunk_key: string;
      }>(
        `SELECT source.source_key, chunk.chunk_key
           FROM document_chunk chunk
           JOIN document document_row
             ON document_row.document_id = chunk.document_id
           JOIN data_source source
             ON source.source_id = document_row.source_id
          WHERE NOT chunk.is_current
          LIMIT 1`
      );
      if (!stale.rows[0]) return;
      const contexts = await repository!.getSourceContexts([
        stale.rows[0]!.source_key
      ]);
      const locators = contexts.records[0]?.locators ?? [];
      expect(
        locators.some(
          (locator) => locator.entityKey === stale.rows[0]!.chunk_key
        )
      ).toBe(false);
      expect(
        locators.some((locator) => locator.entityType === "document_chunk")
      ).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it("reports approved lifecycle capacity without connection details", async () => {
    const capacity = await repository!.storageCapacity();
    expect(capacity.counts).toMatchObject({
      currentChunks: 23_795,
      staleChunks: 17_487,
      currentEmbeddings: 23_795,
      staleEmbeddings: 17_487,
      currentPages: 11_712
    });
    expect(capacity.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          approvalState: "approved",
          currentChunks: 23_795
        })
      ])
    );
    expect(capacity.sizes.documentChunkIndexBytes).toBeGreaterThan(0);
    expect(capacity.settings).toMatchObject({
      maintenanceWorkMem: expect.any(String),
      dynamicSharedMemoryType: expect.any(String)
    });
    expect(JSON.stringify(capacity)).not.toContain("postgresql://");
  });
});
