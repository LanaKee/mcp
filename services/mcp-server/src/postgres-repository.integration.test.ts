import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresDataRepository } from "./postgres-repository.js";
import { createToolRegistry, executeTool } from "./tools.js";

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

  it("prefers official normalized tax and retains row provenance", async () => {
    const taxes = await repository!.getLocalTaxTrend({
      region: "김천시",
      startYear: 2024,
      endYear: 2024,
      taxCategory: "합계",
      dataStatuses: ["official_observed", "demo_sample"]
    });

    expect(taxes.records).toHaveLength(1);
    expect(taxes.records[0]).toMatchObject({
      regionId: "47150",
      dataStatus: "official_observed",
      accountingBasis: "settlement",
      amountSemantics: "collected_amount",
      sourceGrain: "collection_status",
      unitOriginal: "thousand_KRW",
      unitMultiplier: 1000
    });

    const pool = new Pool({ connectionString, max: 1 });
    try {
      const provenance = await pool.query<{
        source_row: number;
        locator_row: number;
      }>(
        `SELECT tax.source_row, locator.row_number AS locator_row
           FROM local_tax_revenue tax
           JOIN source_locator locator
             ON locator.source_id = tax.source_id
            AND locator.entity_type = 'local_tax_revenue'
            AND locator.row_number = tax.source_row
          WHERE tax.region_id = $1
            AND tax.fiscal_year = $2
            AND tax.tax_category = '합계'
            AND tax.data_status = 'official_observed'
          LIMIT 1`,
        ["47150", 2024]
      );
      expect(provenance.rows[0]).toMatchObject({
        source_row: expect.any(Number),
        locator_row: expect.any(Number)
      });
      expect(provenance.rows[0]!.source_row).toBe(
        provenance.rows[0]!.locator_row
      );
    } finally {
      await pool.end();
    }
  });

  it("serves yearbook local-tax subtotals for previously uncovered municipalities", async () => {
    const taxes = await repository!.getLocalTaxTrend({
      region: "포항시",
      startYear: 2024,
      endYear: 2024,
      taxCategory: "합계",
      dataStatuses: ["official_observed", "demo_sample"]
    });
    expect(taxes.records).toEqual([
      expect.objectContaining({
        regionId: "47110",
        fiscalYear: 2024,
        revenueAmountWon: 440_369_434_000,
        dataStatus: "official_observed",
        amountSemantics: "collected_amount",
        sourceGrain: "statistical_yearbook_local_collection",
        unitOriginal: "thousand_KRW",
        unitMultiplier: 1000
      })
    ]);
    expect(taxes.sources[0]).toMatchObject({
      provider: "행정안전부",
      isOfficial: true
    });

    const scopedCountyTax = await repository!.getLocalTaxTrend({
      region: "청도군",
      startYear: 2024,
      endYear: 2024,
      taxCategory: "합계",
      dataStatuses: ["official_observed"]
    });
    expect(scopedCountyTax.records).toEqual([
      expect.objectContaining({
        revenueAmountWon: 33_455_242_000,
        sourceGrain: "statistical_yearbook_local_collection"
      })
    ]);
  });

  it(
    "does not derive the fabricated Kimcheon mixed-status trend",
    async () => {
      const registry = createToolRegistry(repository!);
      const correlationIds = [
        `mixed-tax-${Date.now()}`,
        `mixed-compare-${Date.now()}`
      ];
      const trend = await executeTool(
        registry,
        "get_local_tax_revenue_trend",
        { region: "김천시", startYear: 2020, endYear: 2024 },
        { correlationId: correlationIds[0] }
      );
      expect(trend.result).toMatchObject({
        summary: null,
        summary_unavailable_reason: "incomparable_sources"
      });
      expect(JSON.stringify(trend)).not.toContain("-54.36");

      const comparison = await executeTool(
        registry,
        "compare_population_and_tax",
        { regions: ["김천시"], startYear: 2022, endYear: 2024 },
        { correlationId: correlationIds[1] }
      );
      const comparisonResult = comparison.result as {
        matches: unknown[];
        not_evaluable: Array<{
          taxTrend: unknown;
          matches: unknown;
          notEvaluableReason: string;
        }>;
      };
      expect(comparisonResult.matches).toHaveLength(0);
      expect(comparisonResult.not_evaluable[0]).toMatchObject({
        taxTrend: null,
        matches: null,
        notEvaluableReason: "incomparable_sources"
      });
      expect(JSON.stringify(comparison)).not.toContain("-54.36");

      const pool = new Pool({ connectionString, max: 1 });
      try {
        await pool.query(
          "DELETE FROM mcp_tool_audit WHERE correlation_id = ANY($1::text[])",
          [correlationIds]
        );
      } finally {
        await pool.end();
      }
    },
    15_000
  );

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
