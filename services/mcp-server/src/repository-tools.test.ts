import type { PopulationRecord, SourceRef } from "@gb/domain";
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
    const records: PopulationRecord[] = [
      {
        regionId: "47110",
        regionName: "포항시",
        year: 2024,
        populationTotal: 490_000,
        sourceId: officialSource.sourceId,
        dataStatus: "official_observed"
      }
    ];
    return {
      records,
      sources: [officialSource],
      dataStatuses: ["official_observed"] as const
    };
  }

  override async writeAudit(event: AuditEvent) {
    this.audits.push(event);
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
});
