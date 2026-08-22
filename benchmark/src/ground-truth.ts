/**
 * Resolves each case's answer from the database at run time.
 *
 * Hardcoding expected figures would rot the moment new data is ingested, and a
 * stale expectation silently marks correct answers wrong. Reading the truth from
 * the same store the system serves keeps the benchmark honest in both
 * directions: it also fails loudly if a case's premise stops holding.
 */

import { Client } from "pg";
import type { GroundTruthSpec, ResolvedGroundTruth } from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TruthSource {
  resolve(spec: GroundTruthSpec): Promise<ResolvedGroundTruth>;
  verifySourceIds(sourceIds: string[]): Promise<Set<string>>;
  close(): Promise<void>;
}

const EMPTY: ResolvedGroundTruth = {
  available: false,
  value: null,
  range: null,
  observations: 0,
  sourceIds: [],
  note: "해당 조건에 부합하는 행이 없습니다."
};

/** Reads truth straight from the warehouse the MCP tools serve. */
export class PostgresTruthSource implements TruthSource {
  private readonly client: Client;
  private connected = false;

  constructor(connectionString: string) {
    this.client = new Client({ connectionString });
  }

  private async ensure(): Promise<Client> {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
    return this.client;
  }

  async resolve(spec: GroundTruthSpec): Promise<ResolvedGroundTruth> {
    const client = await this.ensure();
    switch (spec.kind) {
      case "population_year":
        return this.population(client, spec.region, spec.year);
      case "local_tax_total":
        return this.localTax(client, spec.region, spec.fiscalYear, spec.amountSemantics);
      case "council_party_seats":
        return this.councilSeats(client, spec.party);
      case "council_bill_count_year":
        return this.billCount(client, spec.year);
      case "press_release_count_year":
        return this.pressCount(client, spec.year);
      case "policy_program_any":
        return this.policyPrograms(client);
    }
  }

  private async population(
    client: Client,
    region: string,
    year: number
  ): Promise<ResolvedGroundTruth> {
    const { rows } = await client.query<{
      population_total: string;
      reference_date: Date;
      source_id: string;
    }>(
      `select p.population_total, p.reference_date, p.source_id
         from population_observation p
         join dim_region r using (region_id)
        where r.region_name = $1
          and p.year = $2
          and p.data_status = 'official_observed'
        order by p.reference_date desc`,
      [region, year]
    );
    if (rows.length === 0) return { ...EMPTY, note: `${region} ${year}년 인구 관측치 없음` };

    const values = rows
      .map((row) => Number(row.population_total))
      .filter((value) => Number.isFinite(value));
    const latest = values[0];
    if (latest === undefined) return { ...EMPTY, note: `${region} ${year}년 인구 값이 비어 있음` };

    return {
      available: true,
      // The most recent reading of the year is the conventional headline figure.
      value: latest,
      range: { min: Math.min(...values), max: Math.max(...values) },
      observations: rows.length,
      sourceIds: [...new Set(rows.map((row) => row.source_id))],
      note: `${region} ${year}년 주민등록 인구 관측 ${rows.length}건`
    };
  }

  private async localTax(
    client: Client,
    region: string,
    fiscalYear: number,
    amountSemantics: string
  ): Promise<ResolvedGroundTruth> {
    const { rows } = await client.query<{ revenue_amount_won: string; source_id: string }>(
      `select t.revenue_amount_won, t.source_id
         from local_tax_revenue t
         join dim_region r using (region_id)
        where r.region_name = $1
          and t.fiscal_year = $2
          and t.tax_category = '합계'
          and t.is_aggregate
          and t.amount_semantics = $3
          and t.data_status = 'official_observed'
        order by t.revenue_amount_won desc`,
      [region, fiscalYear, amountSemantics]
    );
    const first = rows[0];
    if (first === undefined) {
      return { ...EMPTY, note: `${region} ${fiscalYear}년 ${amountSemantics} 지방세 합계 없음` };
    }
    const value = Number(first.revenue_amount_won);
    return {
      available: true,
      value,
      range: { min: value, max: value },
      observations: rows.length,
      sourceIds: [...new Set(rows.map((row) => row.source_id))],
      note: `${region} ${fiscalYear}년 지방세 합계(${amountSemantics})`
    };
  }

  private async councilSeats(client: Client, party: string): Promise<ResolvedGroundTruth> {
    const { rows } = await client.query<{ n: string; source_id: string }>(
      `select count(*)::text as n, min(source_id::text) as source_id
         from council_member
        where party = $1`,
      [party]
    );
    const first = rows[0];
    const value = first === undefined ? 0 : Number(first.n);
    if (value === 0) return { ...EMPTY, note: `${party} 소속 의원 없음` };
    return {
      available: true,
      value,
      range: { min: value, max: value },
      observations: value,
      sourceIds: first?.source_id ? [first.source_id] : [],
      note: `${party} 소속 경상북도의회 의원 수`
    };
  }

  private async billCount(client: Client, year: number): Promise<ResolvedGroundTruth> {
    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n
         from council_bill
        where extract(year from proposed_date) = $1`,
      [year]
    );
    const value = Number(rows[0]?.n ?? 0);
    if (value === 0) return { ...EMPTY, note: `${year}년 발의 의안 없음` };
    return {
      available: true,
      value,
      range: { min: value, max: value },
      observations: value,
      sourceIds: [],
      note: `${year}년 경상북도의회 발의 의안 건수`
    };
  }

  private async pressCount(client: Client, year: number): Promise<ResolvedGroundTruth> {
    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n
         from press_release
        where extract(year from published_date) = $1`,
      [year]
    );
    const value = Number(rows[0]?.n ?? 0);
    if (value === 0) return { ...EMPTY, note: `${year}년 보도자료 없음` };
    return {
      available: true,
      value,
      range: { min: value, max: value },
      observations: value,
      sourceIds: [],
      note: `${year}년 경상북도 보도자료 건수`
    };
  }

  private async policyPrograms(client: Client): Promise<ResolvedGroundTruth> {
    const { rows } = await client.query<{ n: string }>(
      "select count(*)::text as n from policy_program"
    );
    const value = Number(rows[0]?.n ?? 0);
    if (value === 0) {
      return { ...EMPTY, note: "policy_program 테이블에 적재된 행이 없습니다." };
    }
    return {
      available: true,
      value,
      range: { min: value, max: value },
      observations: value,
      sourceIds: [],
      note: "적재된 정책사업 수"
    };
  }

  /**
   * Returns the subset of ids that name a real source row.
   *
   * This is what separates a citation from an attribution: an id that resolves
   * here can be opened and checked, and one that does not is decoration. Both
   * the surrogate key and the natural `source_key` are accepted, because the
   * tools cite the latter.
   */
  async verifySourceIds(sourceIds: string[]): Promise<Set<string>> {
    if (sourceIds.length === 0) return new Set();
    const client = await this.ensure();
    const uuids = sourceIds.filter((id) => UUID_PATTERN.test(id));
    const keys = sourceIds.filter((id) => !UUID_PATTERN.test(id));

    const verified = new Set<string>();
    if (uuids.length > 0) {
      const { rows } = await client.query<{ source_id: string }>(
        "select source_id::text from data_source where source_id = any($1::uuid[])",
        [uuids]
      );
      for (const row of rows) verified.add(row.source_id);
    }
    if (keys.length > 0) {
      const { rows } = await client.query<{ source_key: string }>(
        "select source_key from data_source where source_key = any($1::text[])",
        [keys]
      );
      for (const row of rows) verified.add(row.source_key);
    }
    return verified;
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.end();
      this.connected = false;
    }
  }
}
