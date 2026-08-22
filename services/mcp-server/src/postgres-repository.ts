import {
  normalizeRegionName,
  type DataStatus,
  type LocalTaxRecord,
  type PolicyRecord,
  type PopulationRecord,
  type SourceRef
} from "@gb/domain";
import {
  hashedKoreanEmbedding,
  normalizeKoreanText,
  PostgresHybridSearchRepository,
  tokenizeKorean
} from "@gb/retrieval";
import { Pool, type QueryResultRow } from "pg";
import type {
  AuditEvent,
  CouncilMemberSummary,
  CoverageOptions,
  DatasetCoverage,
  RegionCoverage,
  CouncilSearchHit,
  DataRepository,
  DocumentSearchHit,
  FactDataStatus,
  MemberBillHit,
  PolicyDocumentCoverage,
  PressReleaseHit,
  RepositoryReadiness,
  RepositoryResult,
  SourceContext,
  SourceLocatorContext,
  StorageCapacitySummary
} from "./repository.js";

interface QueryExecutor {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: T[] }>;
}

interface SourceRow {
  source_key: string;
  title: string;
  provider: string;
  source_url: string | null;
  collected_at: Date | string;
  data_status: DataStatus;
  is_official: boolean;
  file_path: string | null;
  license_note: string | null;
}

function sourceRef(row: SourceRow): SourceRef {
  return {
    sourceId: row.source_key,
    title: row.title,
    provider: row.provider,
    sourceUrl: row.source_url,
    collectedAt:
      row.collected_at instanceof Date
        ? row.collected_at.toISOString()
        : String(row.collected_at),
    dataStatus: row.data_status,
    isOfficial: row.is_official,
    locator: row.file_path,
    note: row.license_note
  };
}

function uniqueSources(rows: SourceRow[]): SourceRef[] {
  return [
    ...new Map(rows.map((row) => [row.source_key, sourceRef(row)])).values()
  ];
}

/** Caps on catalog responses so they remain small enough to put in a prompt. */
const MAX_COVERAGE_REGIONS = 30;
const MAX_COVERAGE_SOURCES = 10;

interface CoverageRow {
  scoped_row_count: string | null;
  scoped_min_year: number | null;
  scoped_max_year: number | null;
  row_count: string;
  min_year: number | null;
  max_year: number | null;
  region_count: string | null;
  regions: string[] | null;
  data_statuses: string[] | null;
  last_observed_at: string | null;
  source_keys: string[] | null;
}

/**
 * How to measure one dataset. Expressed declaratively so every dataset is
 * probed with identical aggregate semantics; a hand-written query per dataset
 * would drift and quietly report incomparable coverage numbers.
 */
interface CoverageProbe {
  /** FROM clause, including any joins needed to reach region/source/date. */
  from: string;
  /** SQL integer expression for the observation year, or null if not time-based. */
  yearExpression: string | null;
  /** SQL text expression naming the region, or null if the dataset has no region. */
  regionExpression: string | null;
  /** SQL date expression for the most recent observation, or null. */
  observedAtExpression: string | null;
  dataStatusExpression: string;
  sourceKeyExpression: string;
  /** Extra predicate, e.g. restricting to the approved current chunk version. */
  where: string | null;
}

const REGION_JOIN = "LEFT JOIN dim_region r ON r.region_id = t.region_id";
const SOURCE_JOIN = "JOIN data_source s ON s.source_id = t.source_id";

const DATASET_COVERAGE_PROBES: Record<string, CoverageProbe> = {
  population_observation: {
    from: `population_observation t ${REGION_JOIN} ${SOURCE_JOIN}`,
    yearExpression: "t.year::int",
    regionExpression: "r.region_name",
    observedAtExpression: "t.reference_date",
    dataStatusExpression: "t.data_status",
    sourceKeyExpression: "s.source_key",
    where: null
  },
  local_tax_revenue: {
    from: `local_tax_revenue t ${REGION_JOIN} ${SOURCE_JOIN}`,
    yearExpression: "t.fiscal_year::int",
    regionExpression: "r.region_name",
    observedAtExpression: "make_date(t.fiscal_year::int, 12, 31)",
    dataStatusExpression: "t.data_status",
    sourceKeyExpression: "s.source_key",
    where: null
  },
  policy_program: {
    from: `policy_program t ${REGION_JOIN} ${SOURCE_JOIN}`,
    yearExpression: "EXTRACT(YEAR FROM t.application_start)::int",
    regionExpression: "r.region_name",
    observedAtExpression: "t.application_end",
    dataStatusExpression: "t.data_status",
    sourceKeyExpression: "s.source_key",
    where: null
  },
  council_record: {
    from: `council_record t ${REGION_JOIN} ${SOURCE_JOIN}`,
    yearExpression: "EXTRACT(YEAR FROM t.meeting_date)::int",
    regionExpression: "r.region_name",
    observedAtExpression: "t.meeting_date",
    dataStatusExpression: "t.data_status",
    sourceKeyExpression: "s.source_key",
    where: null
  },
  press_release: {
    from: `press_release t ${REGION_JOIN} ${SOURCE_JOIN}`,
    yearExpression: "EXTRACT(YEAR FROM t.published_date)::int",
    regionExpression: "r.region_name",
    observedAtExpression: "t.published_date",
    dataStatusExpression: "t.data_status",
    sourceKeyExpression: "s.source_key",
    where: null
  },
  council_bill: {
    from: `council_bill t ${SOURCE_JOIN}`,
    yearExpression: "EXTRACT(YEAR FROM t.proposed_date)::int",
    regionExpression: null,
    observedAtExpression: "t.proposed_date",
    dataStatusExpression: "t.data_status",
    sourceKeyExpression: "s.source_key",
    where: null
  },
  document_chunk: {
    from: `document_chunk t
             JOIN document d ON d.document_id = t.document_id
             LEFT JOIN dim_region r ON r.region_id = d.region_id
             JOIN data_source s ON s.source_id = d.source_id`,
    yearExpression: "EXTRACT(YEAR FROM d.published_date)::int",
    regionExpression: "r.region_name",
    observedAtExpression: "d.published_date",
    dataStatusExpression: "d.data_status",
    sourceKeyExpression: "s.source_key",
    // Only the approved current extraction is retrievable, so coverage must
    // count the same rows a search would actually return.
    where: "t.approved_current"
  }
};

/**
 * Builds the probe query, optionally scoped to one region.
 *
 * Union-wide coverage is actively misleading for planning: population spans
 * 2006-2026 across all regions, but only Pohang has the early years, so a
 * planner trusting the union asks for a window that has no rows for the region
 * it was actually asked about. The region predicate mirrors the one the tools
 * themselves use, so coverage describes exactly the rows a tool would return.
 */
function coverageQuery(probe: CoverageProbe, scopedToRegion: boolean): string {
  const year = probe.yearExpression;
  const region = probe.regionExpression;
  const observedAt = probe.observedAtExpression;
  // The region narrows a FILTER clause rather than the WHERE clause, so one
  // round trip returns both the deployment-wide picture (does this dataset
  // exist here at all) and the region-specific picture (what years exist for
  // the region asked about). Putting it in WHERE made province-level rows —
  // every 경상북도 press release — vanish from a 청도군 question.
  const regionPredicate =
    scopedToRegion && region
      ? "(r.normalized_name = $1 OR r.region_name ILIKE ('%' || $1 || '%'))"
      : null;
  // FILTER binds to the aggregate itself, so any cast must be applied to the
  // filtered result rather than to the aggregate before it.
  const scoped = (aggregate: string, cast: string, fallback: string) =>
    regionPredicate
      ? `(${aggregate} FILTER (WHERE ${regionPredicate}))${cast}`
      : fallback;
  const where = probe.where;
  return `SELECT
      ${scoped("count(*)", "::bigint", "NULL::bigint")} AS scoped_row_count,
      ${year ? scoped(`min(${year})`, "", "NULL::int") : "NULL::int"} AS scoped_min_year,
      ${year ? scoped(`max(${year})`, "", "NULL::int") : "NULL::int"} AS scoped_max_year,
      count(*)::bigint AS row_count,
      ${year ? `min(${year})` : "NULL::int"} AS min_year,
      ${year ? `max(${year})` : "NULL::int"} AS max_year,
      ${
        region
          ? `count(DISTINCT ${region})::bigint`
          : "0::bigint"
      } AS region_count,
      ${
        region
          ? `(array_agg(DISTINCT ${region}) FILTER (WHERE ${region} IS NOT NULL))[1:${MAX_COVERAGE_REGIONS}]`
          : "ARRAY[]::text[]"
      } AS regions,
      array_agg(DISTINCT ${probe.dataStatusExpression}) AS data_statuses,
      ${
        observedAt
          ? `to_char(max(${observedAt}), 'YYYY-MM-DD')`
          : "NULL::text"
      } AS last_observed_at,
      (array_agg(DISTINCT ${probe.sourceKeyExpression}))[1:${MAX_COVERAGE_SOURCES}] AS source_keys
    FROM ${probe.from}
    ${where ? `WHERE ${where}` : ""}`;
}

function unavailableCoverage(
  datasetId: string,
  note: string,
  regionCoverage: RegionCoverage | null = null
): DatasetCoverage {
  return {
    datasetId,
    available: false,
    rowCount: 0,
    yearRange: null,
    regionCount: 0,
    regions: [],
    dataStatuses: [],
    lastObservedAt: null,
    sources: [],
    regionCoverage,
    note
  };
}

function uniqueStatuses(rows: Array<{ data_status: DataStatus }>): DataStatus[] {
  return [...new Set(rows.map((row) => row.data_status))];
}

function memberSummary(row: {
  council_member_id: string;
  name: string;
  party: string | null;
  district: string | null;
  position: string | null;
  career: string | null;
  homepage_url: string;
  lead_count: string | number;
  co_count: string | number;
}): CouncilMemberSummary {
  return {
    councilMemberId: row.council_member_id,
    name: row.name,
    party: row.party,
    district: row.district,
    position: row.position,
    career: row.career,
    homepageUrl: row.homepage_url,
    leadBillCount: Number(row.lead_count),
    coBillCount: Number(row.co_count)
  };
}

function boundedLimit(value: number, maximum: number): number {
  return Math.min(Math.max(Math.trunc(value), 1), maximum);
}

function ftsOrQuery(query: string): string {
  const terms = normalizeKoreanText(query).split(" ").filter(Boolean);
  if (terms.length === 0) throw new Error("검색어에 문자 또는 숫자가 필요합니다.");
  return terms.join(" | ");
}

function capacityThreshold(
  name: string,
  fallback: number,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export class PostgresDataRepository implements DataRepository {
  readonly mode = "postgres" as const;
  private readonly hybrid: PostgresHybridSearchRepository;

  constructor(
    private readonly executor: QueryExecutor,
    private readonly closeExecutor: () => Promise<void> = async () => {}
  ) {
    this.hybrid = new PostgresHybridSearchRepository({
      query: async <T>(text: string, values: unknown[]) => {
        const result = await executor.query(text, values);
        return { rows: result.rows as T[] };
      }
    });
  }

  static fromConnectionString(connectionString: string): PostgresDataRepository {
    const configuredPoolMax = Number(process.env.PG_POOL_MAX ?? 10);
    if (
      !Number.isInteger(configuredPoolMax) ||
      configuredPoolMax < 1 ||
      configuredPoolMax > 50
    ) {
      throw new Error("PG_POOL_MAX must be an integer from 1 to 50");
    }
    const runtimeInteger = (
      name: string,
      fallback: number,
      minimum: number,
      maximum: number
    ): number => {
      const value = Number(process.env[name] ?? fallback);
      if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
      }
      return value;
    };
    const pool = new Pool({
      connectionString,
      max: configuredPoolMax,
      idleTimeoutMillis: runtimeInteger(
        "PG_IDLE_TIMEOUT_MS",
        30_000,
        1_000,
        300_000
      ),
      connectionTimeoutMillis: runtimeInteger(
        "PG_CONNECTION_TIMEOUT_MS",
        5_000,
        500,
        60_000
      ),
      statement_timeout: runtimeInteger(
        "PG_STATEMENT_TIMEOUT_MS",
        8_000,
        500,
        120_000
      ),
      query_timeout: runtimeInteger(
        "PG_QUERY_TIMEOUT_MS",
        10_000,
        500,
        120_000
      )
    });
    return new PostgresDataRepository(pool, async () => pool.end());
  }

  async getPopulationTrend(input: {
    region?: string;
    startYear: number;
    endYear: number;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<RepositoryResult<PopulationRecord>> {
    const region = input.region ? normalizeRegionName(input.region) : null;
    const result = await this.executor.query<
      SourceRow & {
        region_id: string;
        region_name: string;
        year: number;
        population_total: number;
        measurement_basis: PopulationRecord["measurementBasis"];
        reference_date_precision: PopulationRecord["referenceDatePrecision"];
      }
    >(
      `WITH ranked AS (
         SELECT
           p.region_id,
           r.region_name,
           p.year,
           p.population_total,
           p.measurement_basis,
           p.reference_date_precision,
           p.data_status,
           ds.source_key,
           ds.title,
           ds.provider,
           ds.source_url,
           ds.collected_at,
           ds.is_official,
           ds.file_path,
           ds.license_note,
           row_number() OVER (
             PARTITION BY p.region_id, p.year
             ORDER BY
               CASE p.data_status WHEN 'official_observed' THEN 0 ELSE 1 END,
               p.reference_date DESC,
               ds.source_key
           ) AS rank
         FROM population_observation p
         JOIN dim_region r ON r.region_id = p.region_id
         JOIN data_source ds ON ds.source_id = p.source_id
         WHERE p.year BETWEEN $1 AND $2
           AND p.data_status = ANY($3::text[])
           AND ($4::text IS NULL OR r.normalized_name = $4 OR r.region_name ILIKE ('%' || $4 || '%'))
       )
       SELECT *
       FROM ranked
       WHERE rank = 1
       ORDER BY region_name, year
       LIMIT 5000`,
      [input.startYear, input.endYear, [...input.dataStatuses], region]
    );
    return {
      records: result.rows.map((row) => ({
        regionId: row.region_id,
        regionName: row.region_name,
        year: Number(row.year),
        populationTotal: Number(row.population_total),
        measurementBasis: row.measurement_basis,
        referenceDatePrecision: row.reference_date_precision,
        sourceId: row.source_key,
        dataStatus: row.data_status
      })),
      sources: uniqueSources(result.rows),
      dataStatuses: uniqueStatuses(result.rows)
    };
  }

  async getLocalTaxTrend(input: {
    region?: string;
    startYear: number;
    endYear: number;
    taxCategory: string;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<RepositoryResult<LocalTaxRecord>> {
    const region = input.region ? normalizeRegionName(input.region) : null;
    const result = await this.executor.query<
      SourceRow & {
        region_id: string;
        region_name: string;
        fiscal_year: number;
        tax_category: string;
        revenue_amount_won: string | number;
        accounting_basis: "budget" | "settlement" | "reported";
        amount_semantics:
          | "collected_amount"
          | "payment_amount"
          | "reported_total_tax_burden"
          | "demo_settlement"
          | null;
        source_grain:
          | "collection_status"
          | "statistical_yearbook_local_collection"
          | "payment_media"
          | "per_capita_burden"
          | "demo_sample"
          | null;
        unit_original: "KRW" | "thousand_KRW" | null;
        unit_multiplier: number | null;
      }
    >(
      `WITH ranked AS (
         SELECT
           t.region_id,
           r.region_name,
           t.fiscal_year,
           t.tax_category,
           t.revenue_amount_won,
           t.accounting_basis,
           t.amount_semantics,
           t.source_grain,
           t.unit_original,
           t.unit_multiplier,
           t.data_status,
           ds.source_key,
           ds.title,
           ds.provider,
           ds.source_url,
           ds.collected_at,
           ds.is_official,
           ds.file_path,
           ds.license_note,
           row_number() OVER (
             PARTITION BY t.region_id, t.fiscal_year, t.tax_category
             ORDER BY
               CASE t.data_status WHEN 'official_observed' THEN 0 ELSE 1 END,
               CASE t.source_grain
                 WHEN 'collection_status' THEN 0
                 WHEN 'statistical_yearbook_local_collection' THEN 1
                 WHEN 'per_capita_burden' THEN 2
                 WHEN 'payment_media' THEN 3
                 ELSE 4
               END,
               t.is_aggregate DESC,
               ds.source_key
           ) AS rank
         FROM local_tax_revenue t
         JOIN dim_region r ON r.region_id = t.region_id
         JOIN data_source ds ON ds.source_id = t.source_id
         WHERE t.fiscal_year BETWEEN $1 AND $2
           AND t.tax_category = $3
           AND t.data_status = ANY($4::text[])
           AND COALESCE(t.metadata ->> 'headlineEligible', 'true') = 'true'
           AND ($5::text IS NULL OR r.normalized_name = $5 OR r.region_name ILIKE ('%' || $5 || '%'))
       )
       SELECT *
       FROM ranked
       WHERE rank = 1
       ORDER BY region_name, fiscal_year
       LIMIT 5000`,
      [
        input.startYear,
        input.endYear,
        input.taxCategory,
        [...input.dataStatuses],
        region
      ]
    );
    return {
      records: result.rows.map((row) => ({
        regionId: row.region_id,
        regionName: row.region_name,
        fiscalYear: Number(row.fiscal_year),
        taxCategory: row.tax_category,
        revenueAmountWon: Number(row.revenue_amount_won),
        accountingBasis: row.accounting_basis,
        amountSemantics: row.amount_semantics ?? undefined,
        sourceGrain: row.source_grain ?? undefined,
        unitOriginal: row.unit_original ?? undefined,
        unitMultiplier:
          row.unit_multiplier === null
            ? undefined
            : (Number(row.unit_multiplier) as 1 | 1000),
        sourceId: row.source_key,
        dataStatus: row.data_status
      })),
      sources: uniqueSources(result.rows),
      dataStatuses: uniqueStatuses(result.rows)
    };
  }

  async findPolicies(input: {
    region: string;
    query: string;
    dataStatuses: readonly FactDataStatus[];
    limit: number;
  }): Promise<RepositoryResult<PolicyRecord>> {
    const limit = boundedLimit(input.limit, 100);
    const region = normalizeRegionName(input.region);
    const result = await this.executor.query<
      SourceRow & {
        policy_id: string;
        region_id: string | null;
        region_name: string | null;
        policy_title: string;
        target_age_min: number | null;
        target_age_max: number | null;
        industries: string[];
        stages: string[];
        eligibility_text: string;
        support_text: string;
        application_period: string | null;
      }
    >(
      `SELECT
         p.policy_id,
         p.region_id,
         r.region_name,
         p.title AS policy_title,
         p.target_age_min,
         p.target_age_max,
         p.industries,
         p.stages,
         p.eligibility_text,
         p.support_text,
         p.metadata->>'applicationPeriod' AS application_period,
         p.data_status,
         ds.source_key,
         ds.title,
         ds.provider,
         ds.source_url,
         ds.collected_at,
         ds.is_official,
         ds.file_path,
         ds.license_note
       FROM policy_program p
       LEFT JOIN dim_region r ON r.region_id = p.region_id
       JOIN data_source ds ON ds.source_id = p.source_id
       WHERE p.data_status = ANY($1::text[])
         AND (
           p.region_id IS NULL
           OR p.region_id = '47'
           OR r.normalized_name = $2
           OR r.region_name ILIKE ('%' || $2 || '%')
         )
         AND (
           p.title ILIKE ('%' || $3 || '%')
           OR p.eligibility_text ILIKE ('%' || $3 || '%')
           OR p.support_text ILIKE ('%' || $3 || '%')
           OR array_to_string(p.industries, ' ') ILIKE ('%' || $3 || '%')
         )
       ORDER BY
         CASE p.data_status WHEN 'official_observed' THEN 0 ELSE 1 END,
         similarity(p.title, $3) DESC,
         p.policy_id
       LIMIT $4`,
      [[...input.dataStatuses], region, input.query, limit]
    );
    return {
      records: result.rows.map((row) => ({
        policyId: row.policy_id,
        title: row.policy_title,
        regionId: row.region_id ?? "47",
        regionName: row.region_name ?? "경상북도",
        ageMin: row.target_age_min,
        ageMax: row.target_age_max,
        industries: row.industries,
        stages: row.stages,
        eligibilityText: row.eligibility_text,
        support: row.support_text,
        applicationPeriod: row.application_period ?? "공식 공고 확인 필요",
        sourceId: row.source_key,
        dataStatus: row.data_status
      })),
      sources: uniqueSources(result.rows),
      dataStatuses: uniqueStatuses(result.rows)
    };
  }

  private async regionId(region: string | undefined): Promise<string | undefined> {
    if (!region) return undefined;
    const normalized = normalizeRegionName(region);
    const result = await this.executor.query<{ region_id: string }>(
      `SELECT region_id
         FROM dim_region
        WHERE normalized_name = $1 OR region_name ILIKE ('%' || $1 || '%')
        ORDER BY CASE WHEN normalized_name = $1 THEN 0 ELSE 1 END
        LIMIT 1`,
      [normalized]
    );
    return result.rows[0]?.region_id ?? "__unresolved__";
  }

  private async sourcesByKeys(keys: string[]): Promise<SourceRef[]> {
    if (keys.length === 0) return [];
    const result = await this.executor.query<SourceRow>(
      `SELECT
         source_key, title, provider, source_url, collected_at, data_status,
         is_official, file_path, license_note
       FROM data_source
       WHERE source_key = ANY($1::text[])
       LIMIT 200`,
      [[...new Set(keys)].slice(0, 200)]
    );
    return uniqueSources(result.rows);
  }

  /**
   * Full-text plus trigram search over 경상북도 press releases. Bodies flagged as
   * unreadable are excluded so callers never receive mojibake as "context".
   */
  async searchPressReleases(input: {
    query: string;
    region?: string;
    department?: string;
    dateFrom?: string;
    dateTo?: string;
    limit: number;
  }): Promise<RepositoryResult<PressReleaseHit>> {
    const limit = boundedLimit(input.limit, 20);
    const normalizedRegion = input.region ? normalizeRegionName(input.region) : null;
    const result = await this.executor.query<
      SourceRow & {
        press_release_id: string;
        press_title: string;
        body: string;
        region_name: string | null;
        issuing_organization: string;
        department: string | null;
        published_date: string | null;
        detail_url: string;
        attachment_count: number | string;
        mentioned_region_names: string[] | null;
        locator_text: string | null;
        score: number | string;
      }
    >(
      `SELECT
         p.press_release_id,
         p.title AS press_title,
         p.body,
         r.region_name,
         p.issuing_organization,
         p.department,
         p.published_date::text,
         p.detail_url,
         p.attachment_count,
         coalesce(
           (
             SELECT array_agg(m.region_name ORDER BY m.region_name)
             FROM dim_region m
             WHERE m.region_id = ANY(p.mentioned_region_ids)
           ),
           ARRAY[]::text[]
         ) AS mentioned_region_names,
         coalesce(sl.locator_text, ds.file_path) AS locator_text,
         (
           ts_rank(to_tsvector('simple', p.title), to_tsquery('simple', $2)) * 4
           + ts_rank(to_tsvector('simple', p.body), to_tsquery('simple', $2))
           + similarity(p.title, $1)
         )::double precision AS score,
         p.data_status,
         ds.source_key,
         ds.title,
         ds.provider,
         ds.source_url,
         ds.collected_at,
         ds.is_official,
         ds.file_path,
         ds.license_note
       FROM press_release p
       LEFT JOIN dim_region r ON r.region_id = p.region_id
       JOIN data_source ds ON ds.source_id = p.source_id
       LEFT JOIN source_locator sl
         ON sl.source_id = p.source_id
        AND sl.entity_type = 'press_release'
        AND sl.entity_key = p.press_release_id
       WHERE p.content_classification = 'extracted_ok'
         AND (
           $3::text IS NULL
           OR r.normalized_name = $3
           OR EXISTS (
             SELECT 1 FROM dim_region m
             WHERE m.region_id = ANY(p.mentioned_region_ids)
               AND (m.normalized_name = $3 OR m.region_name ILIKE ('%' || $3 || '%'))
           )
         )
         AND ($4::text IS NULL OR p.department ILIKE ('%' || $4 || '%'))
         AND ($5::date IS NULL OR p.published_date >= $5)
         AND ($6::date IS NULL OR p.published_date <= $6)
         AND (
           to_tsvector('simple', p.title) @@ to_tsquery('simple', $2)
           OR to_tsvector('simple', p.body) @@ to_tsquery('simple', $2)
           OR p.title ILIKE ('%' || $1 || '%')
           OR p.title % $1
         )
       ORDER BY score DESC, p.published_date DESC NULLS LAST, p.press_release_id
       LIMIT $7`,
      [
        input.query,
        ftsOrQuery(input.query),
        normalizedRegion,
        input.department ?? null,
        input.dateFrom ?? null,
        input.dateTo ?? null,
        limit
      ]
    );
    const terms = tokenizeKorean(input.query);
    const records: PressReleaseHit[] = result.rows.map((row) => ({
      id: row.press_release_id,
      title: row.press_title,
      text: row.body,
      score: Number(row.score),
      matchedTerms: terms.filter((term) =>
        `${row.press_title} ${row.body}`.normalize("NFC").includes(term)
      ),
      metadata: {
        region: row.region_name ?? "경상북도",
        organization: row.issuing_organization,
        department: row.department,
        publishedDate: row.published_date ?? "",
        sourceId: row.source_key,
        locator: row.locator_text ?? row.file_path ?? "",
        detailUrl: row.detail_url,
        attachmentCount: Number(row.attachment_count),
        mentionedRegions: row.mentioned_region_names ?? [],
        dataStatus: row.data_status as FactDataStatus,
        recordType: "press_release" as const,
        evidenceRole: "narrative_context_only" as const
      }
    }));
    return {
      records,
      sources: uniqueSources(result.rows),
      dataStatuses: uniqueStatuses(result.rows)
    };
  }


  /**
   * Per-member legislative activity for 경상북도의회.
   *
   * Two things this deliberately does NOT do:
   *
   * - It never collapses 대표발의 and 공동발의. A member who signed twelve
   *   colleagues' bills has not authored twelve bills, so the role travels with
   *   every hit and is filterable.
   * - It never scores "pledge fulfilment". The council publishes no pledge
   *   register; the caller gets the legislative record and draws its own
   *   conclusion.
   *
   * Members are matched by name because that is what a caller has. The roster
   * summary is returned alongside the hits so an ambiguous name (two 김상희)
   * surfaces as two members rather than being silently merged.
   */
  /**
   * Loads council members together with their own provenance.
   *
   * The roster is returned to callers as data, so it has to carry sources of
   * its own. Deriving sources from the bill rows alone left every member
   * uncited whenever no bill matched the query.
   */
  private async loadCouncilMembers(filter: {
    name?: string;
    party?: string;
    memberIds?: string[];
  }): Promise<Array<SourceRow & { summary: CouncilMemberSummary }>> {
    const rows = await this.executor.query<
      SourceRow & {
        council_member_id: string;
        name: string;
        party: string | null;
        district: string | null;
        position: string | null;
        career: string | null;
        homepage_url: string;
        lead_count: string | number;
        co_count: string | number;
      }
    >(
      `SELECT
         m.council_member_id,
         m.name,
         m.party,
         m.district,
         m.position,
         m.career,
         m.homepage_url,
         m.data_status,
         ds.source_key,
         ds.title,
         ds.provider,
         ds.source_url,
         ds.collected_at,
         ds.is_official,
         ds.file_path,
         ds.license_note,
         count(*) FILTER (WHERE s.role = 'lead') AS lead_count,
         count(*) FILTER (WHERE s.role = 'co') AS co_count
       FROM council_member m
       JOIN data_source ds ON ds.source_id = m.source_id
       LEFT JOIN council_bill_sponsor s
         ON s.council_member_id = m.council_member_id
       WHERE ($1::text IS NULL OR m.name = $1 OR m.name ILIKE ('%' || $1 || '%'))
         AND ($2::text IS NULL OR m.party ILIKE ('%' || $2 || '%'))
         AND ($3::text[] IS NULL OR m.council_member_id = ANY($3::text[]))
       GROUP BY m.council_member_id, ds.source_id
       ORDER BY (m.name = coalesce($1, m.name)) DESC, m.name
       LIMIT 64`,
      [filter.name ?? null, filter.party ?? null, filter.memberIds ?? null]
    );
    return rows.rows.map((row) => ({ ...row, summary: memberSummary(row) }));
  }

  async searchMemberBills(input: {
    member?: string;
    query?: string;
    role: "lead" | "co" | "any";
    party?: string;
    committee?: string;
    billKind?: string;
    outcome?: string;
    dateFrom?: string;
    dateTo?: string;
    limit: number;
  }): Promise<RepositoryResult<MemberBillHit> & { members: CouncilMemberSummary[] }> {
    const limit = boundedLimit(input.limit, 50);
    const role = input.role === "any" ? null : input.role;

    const memberRows = await this.loadCouncilMembers({
      ...(input.member ? { name: input.member } : {}),
      ...(input.party ? { party: input.party } : {})
    });
    const members = memberRows.map((row) => row.summary);

    // A member filter that matches nobody must return nothing rather than the
    // whole council's legislative record.
    if ((input.member || input.party) && members.length === 0) {
      return { records: [], sources: [], dataStatuses: [], members: [] };
    }
    const memberIds = members.map((member) => member.councilMemberId);
    const restrictToMembers = Boolean(input.member || input.party);

    const result = await this.executor.query<
      SourceRow & {
        council_bill_id: string;
        bill_title: string;
        council_name: string;
        bill_number: string | null;
        bill_kind: string | null;
        committee: string | null;
        session_name: string | null;
        proposed_date: string | null;
        decided_date: string | null;
        status: string | null;
        outcome: string | null;
        member_roles: string[] | null;
        lead_sponsors: string[] | null;
        co_sponsor_count: number | string;
        detail_url: string;
        locator_text: string | null;
        score: number | string;
      }
    >(
      `SELECT
         b.council_bill_id,
         b.title AS bill_title,
         b.council_name,
         b.bill_number,
         b.bill_kind,
         b.committee,
         b.session_name,
         b.proposed_date::text,
         b.decided_date::text,
         b.status,
         b.outcome,
         (
           SELECT array_agg(DISTINCT s.role ORDER BY s.role)
           FROM council_bill_sponsor s
           WHERE s.council_bill_id = b.council_bill_id
             AND ($8::boolean IS FALSE OR s.council_member_id = ANY($9::text[]))
             AND ($1::text IS NULL OR s.role = $1)
         ) AS member_roles,
         (
           SELECT array_agg(s.member_name ORDER BY s.member_name)
           FROM council_bill_sponsor s
           WHERE s.council_bill_id = b.council_bill_id AND s.role = 'lead'
         ) AS lead_sponsors,
         b.co_sponsor_count,
         b.detail_url,
         coalesce(sl.locator_text, ds.file_path) AS locator_text,
         CASE
           WHEN $2::text IS NULL THEN 1::double precision
           ELSE (
             ts_rank(to_tsvector('simple', b.title), to_tsquery('simple', $3))
               * 4
             + similarity(b.title, $2)
           )::double precision
         END AS score,
         b.data_status,
         ds.source_key,
         ds.title,
         ds.provider,
         ds.source_url,
         ds.collected_at,
         ds.is_official,
         ds.file_path,
         ds.license_note
       FROM council_bill b
       JOIN data_source ds ON ds.source_id = b.source_id
       LEFT JOIN source_locator sl
         ON sl.source_id = b.source_id
        AND sl.entity_type = 'council_bill'
        AND sl.entity_key = b.council_bill_id
       WHERE (
           $8::boolean IS FALSE
           OR EXISTS (
             SELECT 1 FROM council_bill_sponsor s
             WHERE s.council_bill_id = b.council_bill_id
               AND s.council_member_id = ANY($9::text[])
               AND ($1::text IS NULL OR s.role = $1)
           )
         )
         AND (
           $8::boolean IS TRUE
           OR $1::text IS NULL
           OR EXISTS (
             SELECT 1 FROM council_bill_sponsor s
             WHERE s.council_bill_id = b.council_bill_id AND s.role = $1
           )
         )
         AND ($4::text IS NULL OR b.committee ILIKE ('%' || $4 || '%'))
         AND ($5::text IS NULL OR b.bill_kind = $5)
         AND ($6::text IS NULL OR b.outcome ILIKE ('%' || $6 || '%'))
         AND ($10::date IS NULL OR b.proposed_date >= $10)
         AND ($11::date IS NULL OR b.proposed_date <= $11)
         AND (
           $2::text IS NULL
           OR to_tsvector('simple', b.title) @@ to_tsquery('simple', $3)
           OR b.title ILIKE ('%' || $2 || '%')
           OR b.title % $2
         )
       ORDER BY score DESC, b.proposed_date DESC NULLS LAST, b.council_bill_id
       LIMIT $7`,
      [
        role,
        input.query ?? null,
        input.query ? ftsOrQuery(input.query) : "",
        input.committee ?? null,
        input.billKind ?? null,
        input.outcome ?? null,
        limit,
        restrictToMembers,
        memberIds,
        input.dateFrom ?? null,
        input.dateTo ?? null
      ]
    );

    const terms = input.query ? tokenizeKorean(input.query) : [];
    const records: MemberBillHit[] = result.rows.map((row) => ({
      id: row.council_bill_id,
      title: row.bill_title,
      // Bills carry no body text on the council site; the title plus its
      // procedural outcome is the whole record.
      text: [
        row.bill_title,
        row.session_name,
        row.committee,
        row.outcome ? `처리결과: ${row.outcome}` : null
      ]
        .filter(Boolean)
        .join(" / "),
      score: Number(row.score),
      matchedTerms: terms.filter((term) =>
        row.bill_title.normalize("NFC").includes(term)
      ),
      metadata: {
        councilName: row.council_name,
        billNumber: row.bill_number,
        billKind: row.bill_kind,
        committee: row.committee,
        sessionName: row.session_name,
        proposedDate: row.proposed_date ?? "",
        decidedDate: row.decided_date,
        status: row.status,
        outcome: row.outcome,
        memberRoles: (row.member_roles ?? []) as Array<"lead" | "co">,
        leadSponsors: row.lead_sponsors ?? [],
        coSponsorCount: Number(row.co_sponsor_count),
        sourceId: row.source_key,
        locator: row.locator_text ?? row.file_path ?? "",
        detailUrl: row.detail_url,
        dataStatus: row.data_status as FactDataStatus,
        recordType: "council_bill" as const,
        evidenceRole: "narrative_context_only" as const
      }
    }));

    // A topic query asks "which bills", so the roster must describe the people
    // behind those bills. Returning the whole council for a topic that matched
    // nothing reads as a result set, and it let callers answer a question that
    // no record supports.
    let reportedMembers = memberRows;
    if (input.query) {
      reportedMembers = [];
      if (records.length > 0) {
        const sponsors = await this.executor.query<{ council_member_id: string }>(
          `SELECT DISTINCT s.council_member_id
             FROM council_bill_sponsor s
            WHERE s.council_bill_id = ANY($1::text[])
              AND s.council_member_id IS NOT NULL
              AND ($2::text IS NULL OR s.role = $2)`,
          [records.map((record) => record.id), role]
        );
        const sponsorIds = sponsors.rows.map((row) => row.council_member_id);
        if (sponsorIds.length > 0) {
          // Re-queried rather than filtered: the unrestricted roster is capped,
          // so filtering it would silently drop sponsors outside that window.
          reportedMembers = await this.loadCouncilMembers({
            ...(input.member ? { name: input.member } : {}),
            ...(input.party ? { party: input.party } : {}),
            memberIds: sponsorIds
          });
        }
      }
    }

    return {
      records,
      sources: uniqueSources([...result.rows, ...reportedMembers]),
      dataStatuses: uniqueStatuses([...result.rows, ...reportedMembers]),
      members: reportedMembers.map((row) => row.summary)
    };
  }

  async searchCouncil(input: {
    query: string;
    region?: string;
    council?: string;
    dateFrom?: string;
    dateTo?: string;
    limit: number;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<RepositoryResult<CouncilSearchHit>> {
    const limit = boundedLimit(input.limit, 20);
    const structuredLimit = Math.min(Math.max(limit * 3, 20), 100);
    const normalizedRegion = input.region ? normalizeRegionName(input.region) : null;
    const structured = await this.executor.query<
      SourceRow & {
        council_record_id: string;
        region_name: string | null;
        council_name: string;
        meeting_date: string | null;
        council_title: string;
        content: string;
        locator_text: string | null;
        score: number | string;
      }
    >(
      `SELECT
         c.council_record_id,
         r.region_name,
         c.council_name,
         c.meeting_date::text,
         c.title AS council_title,
         concat_ws(
           ' ',
           c.title,
           c.session_name,
           c.proposer,
           c.resolution,
           c.metadata->>'content'
         ) AS content,
         coalesce(sl.locator_text, ds.file_path) AS locator_text,
         (
           ts_rank(to_tsvector('simple', c.title), to_tsquery('simple', $2)) * 4
           + similarity(c.title, $1)
           + CASE c.data_status WHEN 'official_observed' THEN 0.25 ELSE 0 END
         )::double precision AS score,
         c.data_status,
         ds.source_key,
         ds.title,
         ds.provider,
         ds.source_url,
         ds.collected_at,
         ds.is_official,
         ds.file_path,
         ds.license_note
       FROM council_record c
       LEFT JOIN dim_region r ON r.region_id = c.region_id
       JOIN data_source ds ON ds.source_id = c.source_id
       LEFT JOIN source_locator sl
         ON sl.source_id = c.source_id
        AND sl.entity_type = 'council_record'
        AND sl.entity_key = c.council_record_id
       WHERE c.data_status = ANY($3::text[])
         AND ($4::text IS NULL OR r.normalized_name = $4 OR r.region_name ILIKE ('%' || $4 || '%'))
         AND ($5::text IS NULL OR c.council_name ILIKE ('%' || $5 || '%'))
         AND ($6::date IS NULL OR c.meeting_date >= $6)
         AND ($7::date IS NULL OR c.meeting_date <= $7)
         AND (
           to_tsvector('simple', c.title) @@ to_tsquery('simple', $2)
           OR c.title ILIKE ('%' || $1 || '%')
           OR c.title % $1
         )
       ORDER BY score DESC, c.council_record_id
       LIMIT $8`,
      [
        input.query,
        ftsOrQuery(input.query),
        [...input.dataStatuses],
        normalizedRegion,
        input.council ?? null,
        input.dateFrom ?? null,
        input.dateTo ?? null,
        structuredLimit
      ]
    );
    const terms = tokenizeKorean(input.query);
    const structuredHits: CouncilSearchHit[] = structured.rows.map((row) => ({
      id: row.council_record_id,
      title: row.council_title,
      text: row.content,
      score: Number(row.score),
      matchedTerms: terms.filter((term) =>
        `${row.council_title} ${row.content}`.normalize("NFC").includes(term)
      ),
      metadata: {
        region: row.region_name ?? "경상북도",
        council: row.council_name,
        meetingDate: row.meeting_date ?? "",
        sourceId: row.source_key,
        locator: row.locator_text ?? row.file_path ?? "",
        dataStatus: row.data_status as FactDataStatus,
        recordType: "council_record"
      }
    }));

    const documents = await this.searchDocuments({
      query: input.query,
      region: input.region,
      organization: input.council,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      limit: structuredLimit,
      dataStatuses: input.dataStatuses
    });
    const ranked = [...structuredHits, ...documents.records]
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, limit);
    const records =
      limit >= 2 &&
      documents.records.length > 0 &&
      !ranked.some((record) => record.metadata.recordType === "document_chunk")
        ? [...ranked.slice(0, -1), documents.records[0]!]
        : ranked;
    const sources = await this.sourcesByKeys(
      records.map((record) => record.metadata.sourceId)
    );
    return {
      records,
      sources,
      dataStatuses: [
        ...new Set(records.map((record) => record.metadata.dataStatus))
      ]
    };
  }

  async searchDocuments(input: {
    query: string;
    region?: string;
    organization?: string;
    documentTypes?: string[];
    dateFrom?: string;
    dateTo?: string;
    limit: number;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<RepositoryResult<DocumentSearchHit>> {
    const limit = boundedLimit(input.limit, 100);
    const regionId = await this.regionId(input.region);
    if (regionId === "__unresolved__") {
      return { records: [], sources: [], dataStatuses: [] };
    }
    const rows = await this.hybrid.search({
      query: input.query,
      queryEmbedding: hashedKoreanEmbedding(input.query, 384),
      embedding: {
        provider: "local",
        model: "hashed-korean-token",
        version: "1-d384",
        dimensions: 384
      },
      regionId,
      organization: input.organization,
      documentTypes: input.documentTypes,
      publishedFrom: input.dateFrom,
      publishedTo: input.dateTo,
      dataStatuses: [...input.dataStatuses],
      limit
    });
    const terms = tokenizeKorean(input.query);
    const records: DocumentSearchHit[] = rows.map((row) => ({
      id: row.chunkId,
      title: row.title,
      text: row.content,
      score: row.score + (row.dataStatus === "official_observed" ? 0.25 : 0),
      matchedTerms: terms.filter((term) =>
        `${row.title} ${row.content}`.normalize("NFC").includes(term)
      ),
      metadata: {
        region: row.regionName ?? "경상북도",
        council: row.organization ?? "의회",
        meetingDate: row.publishedDate ?? "",
        sourceId: row.sourceId,
        locator: `${row.filePath ?? ""}#page=${row.pageStart}`,
        dataStatus: row.dataStatus as FactDataStatus,
        recordType: "document_chunk",
        pageStart: row.pageStart,
        pageEnd: row.pageEnd,
        documentType: row.documentType,
        extractionMethod: row.extractionMethod as "native_pdf_text"
      }
    }));
    return {
      records,
      sources: await this.sourcesByKeys(
        records.map((record) => record.metadata.sourceId)
      ),
      dataStatuses: [
        ...new Set(records.map((record) => record.metadata.dataStatus))
      ]
    };
  }

  async getPolicyDocumentCoverage(
    years: number[]
  ): Promise<RepositoryResult<PolicyDocumentCoverage>> {
    const requested = [...new Set(years)]
      .filter((year) => Number.isInteger(year) && year >= 1900 && year <= 2100)
      .slice(0, 20);
    if (requested.length === 0) {
      return { records: [], sources: [], dataStatuses: [] };
    }
    const result = await this.executor.query<{
      policy_year: number;
      title: string;
      source_key: string;
      file_path: string | null;
      data_status: DataStatus;
      content_classification: PolicyDocumentCoverage["contentClassification"];
      retrieval_available: boolean;
      exclusion_reason: string | null;
    }>(
      `SELECT
         (document_row.metadata->>'policyYear')::integer AS policy_year,
         document_row.title,
         source.source_key,
         source.file_path,
         document_row.data_status,
         document_row.content_classification,
         EXISTS (
           SELECT 1
             FROM document_chunk chunk
            WHERE chunk.document_id = document_row.document_id
              AND chunk.is_current
              AND chunk.approved_current
         ) AS retrieval_available,
         document_row.metadata->>'retrievalExclusionReason' AS exclusion_reason
       FROM document document_row
       JOIN data_source source ON source.source_id = document_row.source_id
       WHERE document_row.document_type = 'provincial_work_plan'
         AND (document_row.metadata->>'policyYear')::integer = ANY($1::integer[])
       ORDER BY policy_year`,
      [requested]
    );
    const records = result.rows.map((row) => ({
      year: row.policy_year,
      title: row.title,
      sourceId: row.source_key,
      sourcePath: row.file_path,
      dataStatus: row.data_status,
      contentClassification: row.content_classification,
      retrievalAvailable: row.retrieval_available,
      exclusionReason: row.exclusion_reason
    }));
    return {
      records,
      sources: await this.sourcesByKeys(records.map((record) => record.sourceId)),
      dataStatuses: [...new Set(records.map((record) => record.dataStatus))]
    };
  }

  async getSourceContexts(
    sourceIds: string[]
  ): Promise<RepositoryResult<SourceContext>> {
    const requested = [...new Set(sourceIds)].slice(0, 20);
    const sources = await this.executor.query<
      SourceRow & { source_id: string; logical_source_id: string | null }
    >(
      `SELECT
         source_id::text,
         source_key,
         title,
         provider,
         source_url,
         collected_at,
         data_status,
         is_official,
         file_path,
         license_note,
         metadata->>'logicalSourceId' AS logical_source_id
       FROM data_source
       WHERE source_key = ANY($1::text[])
          OR source_id::text = ANY($1::text[])
          OR metadata->>'logicalSourceId' = ANY($1::text[])
       ORDER BY source_key
       LIMIT 20`,
      [requested]
    );
    const databaseIds = sources.rows.map((row) => row.source_id);
    const locatorRows =
      databaseIds.length === 0
        ? []
        : (
            await this.executor.query<{
              source_id: string;
              entity_type: string;
              entity_key: string;
              page_number: number | null;
              row_number: number | null;
              section_name: string | null;
              locator_text: string | null;
              excerpt: string | null;
            }>(
              `WITH ranked AS (
                 SELECT
                   sl.source_id::text,
                   sl.entity_type,
                   sl.entity_key,
                   sl.page_number,
                   sl.row_number,
                   sl.section_name,
                   sl.locator_text,
                   CASE
                     WHEN sl.entity_type = 'document_chunk' THEN left(dc.content, 1000)
                     ELSE NULL
                   END AS excerpt,
                   row_number() OVER (
                     PARTITION BY sl.source_id
                     ORDER BY sl.entity_type, sl.page_number NULLS FIRST, sl.entity_key
                   ) AS source_rank
                 FROM source_locator sl
                 LEFT JOIN document_chunk dc
                   ON sl.entity_type = 'document_chunk'
                  AND dc.chunk_key = sl.entity_key
                  AND dc.is_current
                  AND dc.approved_current
                 LEFT JOIN document_page dp
                   ON sl.entity_type = 'document_page'
                  AND dp.page_key = sl.entity_key
                  AND dp.is_current
                 LEFT JOIN pdf_processing_version processing_version
                   ON dc.processing_version_key = processing_version.version_key
                  AND processing_version.approval_state = 'approved'
                 WHERE sl.source_id = ANY($1::uuid[])
                   AND (
                     sl.entity_type NOT IN ('document_chunk', 'document_page')
                     OR (
                       dc.chunk_id IS NOT NULL
                       AND processing_version.version_key IS NOT NULL
                     )
                     OR dp.page_id IS NOT NULL
                   )
               )
               SELECT
                 source_id, entity_type, entity_key, page_number, row_number,
                 section_name, locator_text, excerpt
               FROM ranked
               WHERE source_rank <= 50
               ORDER BY source_id, source_rank
               LIMIT 1000`,
              [databaseIds]
            )
          ).rows;
    const contexts: SourceContext[] = sources.rows.map((row) => ({
      source: sourceRef(row),
      aliases: [
        row.source_key,
        row.source_id,
        ...(row.logical_source_id ? [row.logical_source_id] : [])
      ],
      locators: locatorRows
        .filter((locator) => locator.source_id === row.source_id)
        .map(
          (locator): SourceLocatorContext => ({
            entityType: locator.entity_type,
            entityKey: locator.entity_key,
            pageNumber: locator.page_number,
            rowNumber: locator.row_number,
            sectionName: locator.section_name,
            locatorText: locator.locator_text,
            excerpt: locator.excerpt ?? undefined
          })
        )
    }));
    return {
      records: contexts,
      sources: contexts.map((context) => context.source),
      dataStatuses: [...new Set(contexts.map((context) => context.source.dataStatus))]
    };
  }

  async findPopulationValue(input: {
    region: string;
    year: number;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<RepositoryResult<PopulationRecord>> {
    return this.getPopulationTrend({
      region: input.region,
      startYear: input.year,
      endYear: input.year,
      dataStatuses: input.dataStatuses
    });
  }

  async findLocalTaxValue(input: {
    region: string;
    year: number;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<RepositoryResult<LocalTaxRecord>> {
    return this.getLocalTaxTrend({
      region: input.region,
      startYear: input.year,
      endYear: input.year,
      taxCategory: "합계",
      dataStatuses: input.dataStatuses
    });
  }

  /**
   * Measures live coverage for catalogued datasets.
   *
   * Each dataset is probed with the same aggregate shape so a new dataset only
   * needs a row in {@link DATASET_COVERAGE_PROBES}. Unknown dataset ids and
   * missing tables degrade to `available: false` with a note instead of
   * throwing, because a catalog lookup must never take down a tool call.
   */
  async getDatasetCoverage(
    datasetIds: string[],
    options: CoverageOptions = {}
  ): Promise<DatasetCoverage[]> {
    const region = options.region?.trim() || undefined;
    return Promise.all(
      datasetIds.map(async (datasetId) => {
        const probe = DATASET_COVERAGE_PROBES[datasetId];
        if (!probe) {
          return unavailableCoverage(
            datasetId,
            "카탈로그에 등록되지 않은 데이터셋입니다."
          );
        }
        // A dataset with no region dimension cannot be narrowed, so it keeps
        // union coverage rather than silently reporting an empty scope.
        const scopedToRegion = region !== undefined && probe.regionExpression !== null;
        try {
          const { rows } = await this.executor.query<CoverageRow>(
            coverageQuery(probe, scopedToRegion),
            scopedToRegion ? [region] : []
          );
          const row = rows[0];
          if (!row || Number(row.row_count) === 0) {
            return unavailableCoverage(
              datasetId,
              "테이블은 존재하지만 적재된 행이 없습니다."
            );
          }
          const sourceKeys = (row.source_keys ?? []).filter(Boolean);
          const sources =
            sourceKeys.length > 0
              ? await this.loadSourcesByKey(sourceKeys)
              : [];
          return {
            datasetId,
            available: true,
            rowCount: Number(row.row_count),
            yearRange:
              row.min_year !== null && row.max_year !== null
                ? { start: Number(row.min_year), end: Number(row.max_year) }
                : null,
            regionCount: Number(row.region_count ?? 0),
            regions: (row.regions ?? []).filter(Boolean),
            dataStatuses: (row.data_statuses ?? []).filter(
              Boolean
            ) as DataStatus[],
            lastObservedAt: row.last_observed_at ?? null,
            sources,
            note: null,
            regionCoverage: scopedToRegion
              ? {
                  region: region!,
                  rowCount: Number(row.scoped_row_count ?? 0),
                  yearRange:
                    row.scoped_min_year !== null && row.scoped_max_year !== null
                      ? {
                          start: Number(row.scoped_min_year),
                          end: Number(row.scoped_max_year)
                        }
                      : null
                }
              : null
          } satisfies DatasetCoverage;
        } catch (caught) {
          // A missing table means this deployment simply has not loaded that
          // dataset yet. Surfacing it as unavailable is more useful than an
          // error, and keeps search_datasets working on partial deployments.
          return unavailableCoverage(
            datasetId,
            `커버리지를 측정하지 못했습니다: ${
              caught instanceof Error ? caught.message : String(caught)
            }`
          );
        }
      })
    );
  }

  private async loadSourcesByKey(sourceKeys: string[]): Promise<SourceRef[]> {
    const { rows } = await this.executor.query<SourceRow>(
      `SELECT source_key, title, provider, source_url, collected_at,
              data_status, is_official, file_path, license_note
         FROM data_source
        WHERE source_key = ANY($1::text[])
        ORDER BY collected_at DESC
        LIMIT $2`,
      [sourceKeys, MAX_COVERAGE_SOURCES]
    );
    return rows.map(sourceRef);
  }

  async storageCapacity(): Promise<StorageCapacitySummary> {
    const result = await this.executor.query<{
      current_chunks: string;
      stale_chunks: string;
      current_embeddings: string;
      stale_embeddings: string;
      current_pages: string;
      stale_pages: string;
      expired_audit_rows: string;
      database_bytes: string;
      document_chunk_bytes: string;
      document_chunk_index_bytes: string;
      embedding_bytes: string;
      embedding_index_bytes: string;
      document_page_bytes: string;
      document_page_index_bytes: string;
      server_version: string;
      shared_buffers: string;
      work_mem: string;
      maintenance_work_mem: string;
      max_parallel_maintenance_workers: string;
      dynamic_shared_memory_type: string;
    }>(`
      SELECT
        (SELECT count(*) FROM document_chunk
          WHERE is_current AND approved_current)::text AS current_chunks,
        (SELECT count(*) FROM document_chunk WHERE NOT is_current)::text AS stale_chunks,
        (
          SELECT count(*)
            FROM document_chunk_embedding embedding
            JOIN document_chunk chunk ON chunk.chunk_id = embedding.chunk_id
           WHERE chunk.is_current AND chunk.approved_current
        )::text AS current_embeddings,
        (
          SELECT count(*)
            FROM document_chunk_embedding embedding
            JOIN document_chunk chunk ON chunk.chunk_id = embedding.chunk_id
           WHERE NOT chunk.is_current
        )::text AS stale_embeddings,
        (SELECT count(*) FROM document_page WHERE is_current)::text AS current_pages,
        (SELECT count(*) FROM document_page WHERE NOT is_current)::text AS stale_pages,
        (SELECT count(*) FROM mcp_tool_audit WHERE expires_at < now())::text
          AS expired_audit_rows,
        pg_database_size(current_database())::text AS database_bytes,
        pg_total_relation_size('document_chunk'::regclass)::text AS document_chunk_bytes,
        pg_indexes_size('document_chunk'::regclass)::text
          AS document_chunk_index_bytes,
        pg_total_relation_size('document_chunk_embedding'::regclass)::text AS embedding_bytes,
        pg_indexes_size('document_chunk_embedding'::regclass)::text
          AS embedding_index_bytes,
        pg_total_relation_size('document_page'::regclass)::text AS document_page_bytes,
        pg_indexes_size('document_page'::regclass)::text
          AS document_page_index_bytes,
        current_setting('server_version') AS server_version,
        current_setting('shared_buffers') AS shared_buffers,
        current_setting('work_mem') AS work_mem,
        current_setting('maintenance_work_mem') AS maintenance_work_mem,
        current_setting('max_parallel_maintenance_workers')
          AS max_parallel_maintenance_workers,
        current_setting('dynamic_shared_memory_type') AS dynamic_shared_memory_type
    `);
    const row = result.rows[0]!;
    const counts = {
      currentChunks: Number(row.current_chunks),
      staleChunks: Number(row.stale_chunks),
      currentEmbeddings: Number(row.current_embeddings),
      staleEmbeddings: Number(row.stale_embeddings),
      currentPages: Number(row.current_pages),
      stalePages: Number(row.stale_pages),
      expiredAuditRows: Number(row.expired_audit_rows)
    };
    const sizes = {
      databaseBytes: Number(row.database_bytes),
      documentChunkBytes: Number(row.document_chunk_bytes),
      documentChunkIndexBytes: Number(row.document_chunk_index_bytes),
      embeddingBytes: Number(row.embedding_bytes),
      embeddingIndexBytes: Number(row.embedding_index_bytes),
      documentPageBytes: Number(row.document_page_bytes),
      documentPageIndexBytes: Number(row.document_page_index_bytes)
    };
    const versionRows = await this.executor.query<{
      version_key: string;
      approval_state: "candidate" | "approved" | "retired";
      chunks: string;
      current_chunks: string;
      embeddings: string;
      documents: string;
    }>(`
      SELECT
        version.version_key,
        version.approval_state,
        (
          SELECT count(*) FROM document_chunk chunk
           WHERE chunk.processing_version_key = version.version_key
        )::text AS chunks,
        (
          SELECT count(*) FROM document_chunk chunk
           WHERE chunk.processing_version_key = version.version_key
             AND chunk.is_current
             AND chunk.approved_current
        )::text AS current_chunks,
        (
          SELECT count(DISTINCT embedding.chunk_id)
            FROM document_chunk chunk
            JOIN document_chunk_embedding embedding
              ON embedding.chunk_id = chunk.chunk_id
           WHERE chunk.processing_version_key = version.version_key
        )::text AS embeddings,
        (
          SELECT count(*) FROM document_processing_version document_version
           WHERE document_version.version_key = version.version_key
        )::text AS documents
      FROM pdf_processing_version version
      ORDER BY
        CASE version.approval_state
          WHEN 'approved' THEN 0
          WHEN 'candidate' THEN 1
          ELSE 2
        END,
        version.version_key
      LIMIT 100
    `);
    const warnings: string[] = [];
    const staleRatioThreshold = capacityThreshold(
      "STORAGE_WARN_STALE_RATIO_PERCENT",
      25,
      1,
      100
    );
    const totalChunks = counts.currentChunks + counts.staleChunks;
    const staleRatio =
      totalChunks === 0 ? 0 : (counts.staleChunks / totalChunks) * 100;
    if (staleRatio >= staleRatioThreshold) {
      warnings.push(
        `stale_chunk_ratio:${staleRatio.toFixed(1)}%>=${staleRatioThreshold}%`
      );
    }
    const databaseThreshold = capacityThreshold(
      "STORAGE_WARN_DATABASE_BYTES",
      2_147_483_648,
      1_048_576
    );
    if (sizes.databaseBytes >= databaseThreshold) {
      warnings.push(
        `database_bytes:${sizes.databaseBytes}>=${databaseThreshold}`
      );
    }
    const embeddingThreshold = capacityThreshold(
      "STORAGE_WARN_EMBEDDING_ROWS",
      250_000,
      1_000,
      100_000_000
    );
    if (
      counts.currentEmbeddings + counts.staleEmbeddings >=
      embeddingThreshold
    ) {
      warnings.push(
        `embedding_rows:${counts.currentEmbeddings + counts.staleEmbeddings}>=${embeddingThreshold}`
      );
    }
    const auditThreshold = capacityThreshold(
      "STORAGE_WARN_EXPIRED_AUDIT_ROWS",
      10_000,
      1,
      100_000_000
    );
    if (counts.expiredAuditRows >= auditThreshold) {
      warnings.push(
        `expired_audit_rows:${counts.expiredAuditRows}>=${auditThreshold}`
      );
    }
    return {
      generatedAt: new Date().toISOString(),
      counts,
      sizes,
      versions: versionRows.rows.map((version) => ({
        versionKey: version.version_key,
        approvalState: version.approval_state,
        chunks: Number(version.chunks),
        currentChunks: Number(version.current_chunks),
        embeddings: Number(version.embeddings),
        documents: Number(version.documents)
      })),
      settings: {
        serverVersion: row.server_version,
        sharedBuffers: row.shared_buffers,
        workMem: row.work_mem,
        maintenanceWorkMem: row.maintenance_work_mem,
        maxParallelMaintenanceWorkers:
          row.max_parallel_maintenance_workers,
        dynamicSharedMemoryType: row.dynamic_shared_memory_type
      },
      warnings
    };
  }

  async readiness(): Promise<RepositoryReadiness> {
    try {
      const result = await this.executor.query<{
        database_ready: boolean;
      }>(
        `SELECT
           to_regclass('public.population_observation') IS NOT NULL
           AND to_regclass('public.local_tax_revenue') IS NOT NULL
           AND to_regclass('public.policy_program') IS NOT NULL
           AND to_regclass('public.council_record') IS NOT NULL
           AND to_regclass('public.document') IS NOT NULL
           AND to_regclass('public.document_chunk') IS NOT NULL
           AND to_regclass('public.document_chunk_embedding') IS NOT NULL
           AND to_regclass('public.pdf_processing_version') IS NOT NULL
           AND to_regclass('public.storage_maintenance_run') IS NOT NULL
           AND to_regclass('public.mcp_tool_audit') IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'mcp_tool_audit'
               AND column_name = 'correlation_id'
           )
           AND EXISTS (
             SELECT 1
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'document_chunk'
               AND column_name = 'approved_current'
           ) AS database_ready`
      );
      return {
        ready: result.rows[0]?.database_ready === true,
        mode: this.mode,
        detail:
          result.rows[0]?.database_ready === true
            ? undefined
            : "required_schema_missing"
      };
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "query_failed";
      return { ready: false, mode: this.mode, detail: code };
    }
  }

  async writeAudit(event: AuditEvent): Promise<void> {
    await this.executor.query(
      `INSERT INTO mcp_tool_audit
        (
          tool_name,
          started_at,
          finished_at,
          duration_ms,
          success,
          data_statuses,
          result_count,
          request_hash,
          request_metadata,
          correlation_id,
          error_class,
          repository_mode
        )
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9::jsonb, $10, $11, 'postgres')`,
      [
        event.toolName,
        event.startedAt,
        event.finishedAt,
        Math.max(0, event.finishedAt.getTime() - event.startedAt.getTime()),
        event.success,
        event.dataStatuses.slice(0, 4),
        Math.max(0, event.resultCount),
        event.requestHash,
        JSON.stringify(event.requestMetadata),
        event.correlationId,
        event.errorClass
      ]
    );
  }

  async close(): Promise<void> {
    await this.closeExecutor();
  }
}
