import type { LocalTaxRecord, PopulationRecord, SourceRef } from "@gb/domain";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadDemoData, type DemoDataStore } from "./data-store.js";
import {
  InMemoryDataRepository,
  type AuditEvent,
  type FactDataStatus
} from "./repository.js";
import { createToolRegistry, executeTool } from "./tools.js";

const officialSource: SourceRef = {
  sourceId: "official-source",
  title: "공식 인구",
  provider: "테스트 기관",
  sourceUrl: null,
  collectedAt: "2026-01-01T00:00:00.000Z",
  dataStatus: "official_observed",
  isOfficial: true
};

const demoTaxSource: SourceRef = {
  sourceId: "demo-tax",
  title: "가상 지방세",
  provider: "테스트",
  sourceUrl: null,
  collectedAt: "2026-01-01T00:00:00.000Z",
  dataStatus: "demo_sample",
  isOfficial: false
};

class FakeRepository extends InMemoryDataRepository {
  readonly populationInputs: FactDataStatus[][] = [];
  readonly audits: AuditEvent[] = [];

  override async getPopulationTrend(input: {
    region?: string;
    startYear: number;
    endYear: number;
    dataStatuses: readonly FactDataStatus[];
  }) {
    this.populationInputs.push([...input.dataStatuses]);
    const records: PopulationRecord[] = [2022, 2023, 2024]
      .map((year, index) => ({
        regionId: "47150",
        regionName: "김천시",
        year,
        populationTotal: 490_000 - index * 1_000,
        measurementBasis: "resident_registration_snapshot" as const,
        referenceDatePrecision: "month" as const,
        sourceId: officialSource.sourceId,
        dataStatus: "official_observed"
      }))
      .filter(
        (row) => row.year >= input.startYear && row.year <= input.endYear
      );
    return {
      records,
      sources: [officialSource],
      dataStatuses: ["official_observed"] as const
    };
  }

  override async writeAudit(event: AuditEvent) {
    this.audits.push(event);
  }

  override async getLocalTaxTrend(input: {
    startYear: number;
    endYear: number;
  }) {
    const records: LocalTaxRecord[] = [
      {
        regionId: "47150",
        regionName: "김천시",
        fiscalYear: 2022,
        taxCategory: "합계",
        revenueAmountWon: 236_000_000_000,
        accountingBasis: "settlement",
        amountSemantics: "demo_settlement",
        sourceGrain: "demo_sample",
        unitOriginal: "KRW",
        unitMultiplier: 1,
        sourceId: demoTaxSource.sourceId,
        dataStatus: "demo_sample"
      },
      {
        regionId: "47150",
        regionName: "김천시",
        fiscalYear: 2023,
        taxCategory: "합계",
        revenueAmountWon: 231_000_000_000,
        accountingBasis: "settlement",
        amountSemantics: "demo_settlement",
        sourceGrain: "demo_sample",
        unitOriginal: "KRW",
        unitMultiplier: 1,
        sourceId: demoTaxSource.sourceId,
        dataStatus: "demo_sample"
      },
      {
        regionId: "47150",
        regionName: "김천시",
        fiscalYear: 2024,
        taxCategory: "합계",
        revenueAmountWon: 107_720_311_000,
        accountingBasis: "settlement",
        amountSemantics: "collected_amount",
        sourceGrain: "collection_status",
        unitOriginal: "thousand_KRW",
        unitMultiplier: 1000,
        sourceId: officialSource.sourceId,
        dataStatus: "official_observed"
      }
    ].filter(
      (row) =>
        row.fiscalYear >= input.startYear &&
        row.fiscalYear <= input.endYear
    );
    return {
      records,
      sources: [demoTaxSource, officialSource],
      dataStatuses: [
        ...new Set(records.map((record) => record.dataStatus))
      ]
    };
  }
}

class HomogeneousOfficialRepository extends FakeRepository {
  override async getLocalTaxTrend(input: {
    startYear: number;
    endYear: number;
  }) {
    const records: LocalTaxRecord[] = [2023, 2024]
      .map((fiscalYear, index) => ({
        regionId: "47150",
        regionName: "김천시",
        fiscalYear,
        taxCategory: "합계",
        revenueAmountWon: 100 + index * 10,
        accountingBasis: "settlement" as const,
        amountSemantics: "collected_amount" as const,
        sourceGrain: "collection_status" as const,
        unitOriginal: "KRW" as const,
        unitMultiplier: 1 as const,
        sourceId: officialSource.sourceId,
        dataStatus: "official_observed" as const
      }))
      .filter(
        (row) =>
          row.fiscalYear >= input.startYear &&
          row.fiscalYear <= input.endYear
      );
    return {
      records,
      sources: [officialSource],
      dataStatuses: ["official_observed"] as const
    };
  }
}

describe("repository-injected tools", () => {
  let store: DemoDataStore;

  beforeAll(async () => {
    store = await loadDemoData();
  });

  it("propagates explicit statuses and audits only redacted request shape", async () => {
    const repository = new FakeRepository(store);
    const response = await executeTool(
      createToolRegistry(repository),
      "get_population_trend",
      {
        region: "포항시",
        startYear: 2024,
        endYear: 2024,
        dataStatuses: ["official_observed"]
      }
    );

    expect(repository.populationInputs).toEqual([["official_observed"]]);
    expect(response.data_status).toBe("official_observed");
    expect(repository.audits).toHaveLength(1);
    expect(repository.audits[0]).toMatchObject({
      toolName: "get_population_trend",
      success: true,
      dataStatuses: ["official_observed"],
      resultCount: 1
    });
    expect(repository.audits[0]!.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(repository.audits[0]!.requestMetadata)).not.toContain(
      "포항시"
    );
  });

  it("keeps a successful read successful when best-effort audit storage fails", async () => {
    const repository = new FakeRepository(store);
    repository.writeAudit = async () => {
      throw Object.assign(new Error("audit unavailable"), { code: "42P01" });
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await executeTool(
      createToolRegistry(repository),
      "get_population_trend",
      { region: "포항시", startYear: 2024, endYear: 2024 }
    );

    expect(response.result).toBeDefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"warning":"audit_write_failed"')
    );
    errorSpy.mockRestore();
  });

  it("does not persist arbitrary unsupported tool names or input keys", async () => {
    const repository = new FakeRepository(store);
    await expect(
      executeTool(createToolRegistry(repository), "secret-query-value", {
        "private query text": "sensitive"
      })
    ).rejects.toThrow("지원하지 않는 도구");

    expect(repository.audits[0]!.toolName).toBe("unsupported");
    expect(repository.audits[0]!.requestMetadata).toMatchObject({
      keys: [],
      unknownFieldCount: 1
    });
    expect(JSON.stringify(repository.audits[0]!.requestMetadata)).not.toContain(
      "private query text"
    );
  });

  it("labels official and sample tax points without an ambiguous trend envelope", async () => {
    const repository = new FakeRepository(store);
    const response = await executeTool(
      createToolRegistry(repository),
      "get_local_tax_revenue_trend",
      {
        region: "김천시",
        startYear: 2023,
        endYear: 2024
      }
    );
    const result = response.result as {
      accounting_basis: string;
      amount_semantics: string[];
      points: Array<{
        dataStatus: string;
        amountSemantics: string | null;
        sourceGrain: string | null;
      }>;
      summary: unknown;
      summary_unavailable_reason: string;
    };
    expect(response.data_status).toBe("mixed");
    expect(result.points).toEqual([
      expect.objectContaining({
        dataStatus: "demo_sample",
        amountSemantics: "demo_settlement",
        sourceGrain: "demo_sample"
      }),
      expect.objectContaining({
        dataStatus: "official_observed",
        amountSemantics: "collected_amount",
        sourceGrain: "collection_status"
      })
    ]);
    expect(response.limitations.join(" ")).toContain("각 점의 dataStatus");
    expect(result.summary).toBeNull();
    expect(result.summary_unavailable_reason).toBe("incomparable_sources");
  });

  it("reproduces Kimcheon without the fabricated mixed -54.36% trend", async () => {
    const repository = new FakeRepository(store);
    const trend = await executeTool(
      createToolRegistry(repository),
      "get_local_tax_revenue_trend",
      { region: "김천시", startYear: 2020, endYear: 2024 }
    );
    const result = trend.result as {
      summary: unknown;
      summary_unavailable_reason: string;
      series_segments: unknown[];
    };
    expect(result).toMatchObject({
      summary: null,
      summary_unavailable_reason: "incomparable_sources"
    });
    expect(result.series_segments).toHaveLength(2);
    expect(JSON.stringify(trend)).not.toContain("-54.36");

    const comparison = await executeTool(
      createToolRegistry(repository),
      "compare_population_and_tax",
      { regions: ["김천시"], startYear: 2022, endYear: 2024 }
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
  });

  it("still summarizes a homogeneous official tax series", async () => {
    const repository = new HomogeneousOfficialRepository(store);
    const response = await executeTool(
      createToolRegistry(repository),
      "get_local_tax_revenue_trend",
      { region: "김천시", startYear: 2023, endYear: 2024 }
    );
    expect(response.result).toMatchObject({
      summary: {
        absoluteChange: 10,
        changePercent: 10,
        direction: "increase"
      },
      summary_unavailable_reason: null
    });
  });

  it("does not verify claims against demo tax values", async () => {
    const repository = new FakeRepository(store);
    const response = await executeTool(
      createToolRegistry(repository),
      "verify_claim_with_data",
      {
        metric: "local_tax",
        region: "김천시",
        year: 2023,
        claimedValue: 231_000_000_000
      }
    );
    expect(response.result).toMatchObject({
      verdict: "not_verifiable",
      verification_unavailable_reason: "demo_data_not_evidence",
      difference: null,
      difference_percent: null
    });
  });
});
