import { describe, expect, it } from "vitest";
import { PostgresDataRepository } from "./postgres-repository.js";

class RecordingExecutor {
  readonly calls: Array<{ text: string; values: unknown[] }> = [];

  async query<T>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ text, values });
    if (text.includes("FROM dim_region")) {
      return { rows: [{ region_id: "47110" } as T] };
    }
    return { rows: [] };
  }
}

describe("PostgresDataRepository query contracts", () => {
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
      errorClass: null
    });

    const call = executor.calls[0]!;
    expect(call.text).not.toContain("search_council_records");
    expect(call.text).toContain("VALUES ($1, $2, $3");
    expect(call.values[0]).toBe("search_council_records");
    expect(call.values[3]).toBe(125);
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
});
