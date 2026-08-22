import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresDataRepository } from "./postgres-repository.js";

class RecordingExecutor {
  readonly calls: Array<{ text: string; values: unknown[] }> = [];

  async query<T>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ text, values });
    if (text.includes("FROM dim_region")) {
      return { rows: [{ region_id: "47110" } as T] };
    }
    if (text.includes("FROM data_source")) {
      return {
        rows: [
          {
            source_id: "00000000-0000-5000-8000-000000000001",
            source_key: "source-key",
            logical_source_id: null,
            title: "source",
            provider: "provider",
            source_url: null,
            collected_at: null,
            data_status: "official_observed",
            is_official: true,
            file_path: "datasets/source.pdf",
            license_note: null
          } as T
        ]
      };
    }
    if (text.includes("pg_database_size")) {
      return {
        rows: [
          {
            current_chunks: "10",
            stale_chunks: "2",
            current_embeddings: "10",
            stale_embeddings: "2",
            current_pages: "5",
            stale_pages: "0",
            expired_audit_rows: "0",
            database_bytes: "1000",
            document_chunk_bytes: "400",
            document_chunk_index_bytes: "100",
            embedding_bytes: "300",
            embedding_index_bytes: "50",
            document_page_bytes: "200",
            document_page_index_bytes: "40",
            server_version: "16",
            shared_buffers: "128MB",
            work_mem: "4MB",
            maintenance_work_mem: "64MB",
            max_parallel_maintenance_workers: "2",
            dynamic_shared_memory_type: "posix"
          } as T
        ]
      };
    }
    return { rows: [] };
  }
}

describe("PostgresDataRepository query contracts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps fact filters parameterized and bounded", async () => {
    const executor = new RecordingExecutor();
    const repository = new PostgresDataRepository(executor);

    await repository.getLocalTaxTrend({
      region: "포항시",
      startYear: 2022,
      endYear: 2024,
      taxCategory: "합계' OR true --",
      dataStatuses: ["demo_sample"]
    });

    const call = executor.calls[0]!;
    expect(call.text).not.toContain("합계' OR true --");
    expect(call.text).toContain("t.tax_category = $3");
    expect(call.text).toContain("LIMIT 5000");
    expect(call.values).toEqual([
      2022,
      2024,
      "합계' OR true --",
      ["demo_sample"],
      "포항시"
    ]);
  });

  it("uses the shared bounded hybrid query with values outside SQL text", async () => {
    const executor = new RecordingExecutor();
    const repository = new PostgresDataRepository(executor);

    await repository.searchDocuments({
      query: "지방소멸 청년",
      region: "포항시",
      organization: "경상북도의회",
      limit: 500,
      dataStatuses: ["official_observed"]
    });

    const hybrid = executor.calls.find((call) =>
      call.text.includes("WITH candidate_ids AS MATERIALIZED")
    );
    expect(hybrid).toBeDefined();
    expect(hybrid!.text).not.toContain("지방소멸 청년");
    expect(hybrid!.values[0]).toBe("지방소멸 청년");
    expect(hybrid!.values[6]).toBe(50);
    expect(hybrid!.values[14]).toEqual(["official_observed"]);
    expect(hybrid!.values[15]).toBe("경상북도의회");
  });

  it("parameterizes redacted audit records", async () => {
    const executor = new RecordingExecutor();
    const repository = new PostgresDataRepository(executor);

    await repository.writeAudit({
      toolName: "search_council_records",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      finishedAt: new Date("2026-01-01T00:00:00.125Z"),
      success: true,
      dataStatuses: ["official_observed"],
      resultCount: 2,
      requestHash: "a".repeat(64),
      requestMetadata: { keys: ["query"], fields: { query: { length: 12 } } },
      correlationId: "trace_1234-safe",
      errorClass: null
    });

    const call = executor.calls[0]!;
    expect(call.text).not.toContain("search_council_records");
    expect(call.text).toContain("VALUES ($1, $2, $3");
    expect(call.values[0]).toBe("search_council_records");
    expect(call.values[3]).toBe(125);
    expect(call.values[9]).toBe("trace_1234-safe");
  });

  it("filters stale page and chunk locators from source context", async () => {
    const executor = new RecordingExecutor();
    const repository = new PostgresDataRepository(executor);

    await repository.getSourceContexts(["source-key"]);

    const locatorQuery = executor.calls.find((call) =>
      call.text.includes("FROM source_locator sl")
    );
    expect(locatorQuery?.text).toContain("dc.is_current");
    expect(locatorQuery?.text).toContain("dc.approved_current");
    expect(locatorQuery?.text).toContain("dp.is_current");
    expect(locatorQuery?.text).toContain(
      "processing_version.approval_state = 'approved'"
    );
    expect(locatorQuery?.text).toContain(
      "sl.entity_type NOT IN ('document_chunk', 'document_page')"
    );
    expect(locatorQuery?.values).toEqual([
      ["00000000-0000-5000-8000-000000000001"]
    ]);
  });

  it("bounds the admin capacity version report", async () => {
    const executor = new RecordingExecutor();
    const repository = new PostgresDataRepository(executor);

    const report = await repository.storageCapacity();

    expect(report.sizes).toMatchObject({
      documentChunkBytes: 400,
      documentChunkIndexBytes: 100
    });
    expect(executor.calls[1]?.text).toContain("LIMIT 100");
    expect(executor.calls[1]?.text).toContain(
      "chunk.processing_version_key = version.version_key"
    );
  });

  it("rejects invalid admin capacity thresholds", async () => {
    vi.stubEnv("STORAGE_WARN_STALE_RATIO_PERCENT", "101");
    const repository = new PostgresDataRepository(new RecordingExecutor());
    await expect(repository.storageCapacity()).rejects.toThrow(
      "STORAGE_WARN_STALE_RATIO_PERCENT must be an integer from 1 to 100"
    );
  });

  it("closes its injected pool exactly once per close call", async () => {
    const executor = new RecordingExecutor();
    let closes = 0;
    const repository = new PostgresDataRepository(executor, async () => {
      closes += 1;
    });
    await repository.close();
    expect(closes).toBe(1);
  });

  it("rejects unsafe PostgreSQL timeout configuration before connecting", () => {
    vi.stubEnv("PG_STATEMENT_TIMEOUT_MS", "0");
    expect(() =>
      PostgresDataRepository.fromConnectionString(
        "postgresql://localhost/unreachable"
      )
    ).toThrow("PG_STATEMENT_TIMEOUT_MS must be an integer");
  });
});
