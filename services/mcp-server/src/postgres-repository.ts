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
  CouncilSearchHit,
  DataRepository,
  DocumentSearchHit,
  FactDataStatus,
  RepositoryReadiness,
  RepositoryResult,
  SourceContext,
  SourceLocatorContext
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

function uniqueStatuses(rows: Array<{ data_status: DataStatus }>): DataStatus[] {
  return [...new Set(rows.map((row) => row.data_status))];
}

function boundedLimit(value: number, maximum: number): number {
  return Math.min(Math.max(Math.trunc(value), 1), maximum);
}

function ftsOrQuery(query: string): string {
  const terms = normalizeKoreanText(query).split(" ").filter(Boolean);
  if (terms.length === 0) throw new Error("검색어에 문자 또는 숫자가 필요합니다.");
  return terms.join(" | ");
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
    const pool = new Pool({
      connectionString,
      max: configuredPoolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000
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
      }
    >(
      `WITH ranked AS (
         SELECT
           p.region_id,
           r.region_name,
           p.year,
           p.population_total,
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
        accounting_basis: "budget" | "settlement";
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
             PARTITION BY t.region_id, t.fiscal_year, t.tax_category, t.accounting_basis
             ORDER BY CASE t.data_status WHEN 'official_observed' THEN 0 ELSE 1 END, ds.source_key
           ) AS rank
         FROM local_tax_revenue t
         JOIN dim_region r ON r.region_id = t.region_id
         JOIN data_source ds ON ds.source_id = t.source_id
         WHERE t.fiscal_year BETWEEN $1 AND $2
           AND t.tax_category = $3
           AND t.data_status = ANY($4::text[])
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
        pageEnd: row.pageEnd
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
                 WHERE sl.source_id = ANY($1::uuid[])
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
           AND to_regclass('public.mcp_tool_audit') IS NOT NULL AS database_ready`
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
          error_class,
          repository_mode
        )
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9::jsonb, $10, 'postgres')`,
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
        event.errorClass
      ]
    );
  }

  async close(): Promise<void> {
    await this.closeExecutor();
  }
}
