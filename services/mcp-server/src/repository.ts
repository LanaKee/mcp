import type {
  CouncilRecord,
  DataStatus,
  LocalTaxRecord,
  PolicyRecord,
  PopulationRecord,
  SourceRef
} from "@gb/domain";
import {
  DisabledVectorAdapter,
  hybridSearch,
  type SearchDocument
} from "@gb/retrieval";
import type { DemoDataStore } from "./data-store.js";

export type FactDataStatus = Extract<
  DataStatus,
  "official_observed" | "demo_sample"
>;

export const DEFAULT_FACT_STATUSES: readonly FactDataStatus[] = [
  "official_observed"
];

export interface RepositoryResult<T> {
  records: T[];
  sources: SourceRef[];
  dataStatuses: DataStatus[];
}

export interface PopulationRepository {
  getPopulationTrend(input: {
    region?: string;
    startYear: number;
    endYear: number;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<RepositoryResult<PopulationRecord>>;
}

export interface LocalTaxRepository {
  getLocalTaxTrend(input: {
    region?: string;
    startYear: number;
    endYear: number;
    taxCategory: string;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<RepositoryResult<LocalTaxRecord>>;
}

export interface PolicyRepository {
  findPolicies(input: {
    region: string;
    query: string;
    dataStatuses: readonly FactDataStatus[];
    limit: number;
  }): Promise<RepositoryResult<PolicyRecord>>;
}

export interface CouncilSearchHit {
  id: string;
  title: string;
  text: string;
  score: number;
  matchedTerms: string[];
  metadata: {
    region: string;
    council: string;
    meetingDate: string;
    sourceId: string;
    locator: string;
    dataStatus: FactDataStatus;
    recordType: "council_record" | "document_chunk";
    pageStart?: number;
    pageEnd?: number;
  };
}

export interface DocumentSearchHit extends CouncilSearchHit {
  metadata: CouncilSearchHit["metadata"] & {
    recordType: "document_chunk";
    pageStart: number;
    pageEnd: number;
    documentType: string;
    extractionMethod: "native_pdf_text";
  };
}

export interface PolicyDocumentCoverage {
  year: number;
  title: string;
  sourceId: string;
  sourcePath: string | null;
  dataStatus: DataStatus;
  contentClassification:
    | "extracted_ok"
    | "mojibake_suspected"
    | "unusable_for_retrieval"
    | "empty";
  retrievalAvailable: boolean;
  exclusionReason: string | null;
}

export interface DocumentRepository {
  searchDocuments(input: {
    query: string;
    region?: string;
    organization?: string;
    documentTypes?: string[];
    dateFrom?: string;
    dateTo?: string;
    limit: number;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<RepositoryResult<DocumentSearchHit>>;
  getPolicyDocumentCoverage(
    years: number[]
  ): Promise<RepositoryResult<PolicyDocumentCoverage>>;
}

export interface CouncilRepository {
  searchCouncil(input: {
    query: string;
    region?: string;
    council?: string;
    dateFrom?: string;
    dateTo?: string;
    limit: number;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<RepositoryResult<CouncilSearchHit>>;
}

/**
 * A press release hit. `recordType` is fixed so callers can never confuse this
 * narrative material with an observed statistic.
 */
export interface PressReleaseHit {
  id: string;
  title: string;
  text: string;
  score: number;
  matchedTerms: string[];
  metadata: {
    region: string;
    organization: string;
    department: string | null;
    publishedDate: string;
    sourceId: string;
    locator: string;
    detailUrl: string;
    attachmentCount: number;
    mentionedRegions: string[];
    dataStatus: FactDataStatus;
    recordType: "press_release";
    evidenceRole: "narrative_context_only";
  };
}

export interface PressReleaseRepository {
  searchPressReleases(input: {
    query: string;
    region?: string;
    department?: string;
    dateFrom?: string;
    dateTo?: string;
    limit: number;
  }): Promise<RepositoryResult<PressReleaseHit>>;
}

export interface CouncilMemberSummary {
  councilMemberId: string;
  name: string;
  party: string | null;
  district: string | null;
  position: string | null;
  career: string | null;
  homepageUrl: string;
  /** Bills the member led (대표발의) across the whole crawled record. */
  leadBillCount: number;
  /** Bills the member co-signed (공동발의). */
  coBillCount: number;
}

export interface MemberBillHit {
  id: string;
  title: string;
  text: string;
  score: number;
  matchedTerms: string[];
  metadata: {
    councilName: string;
    billNumber: string | null;
    billKind: string | null;
    committee: string | null;
    sessionName: string | null;
    proposedDate: string;
    decidedDate: string | null;
    status: string | null;
    outcome: string | null;
    /** Sponsorship roles the queried member holds on this bill. */
    memberRoles: Array<"lead" | "co">;
    leadSponsors: string[];
    coSponsorCount: number;
    sourceId: string;
    locator: string;
    detailUrl: string;
    dataStatus: FactDataStatus;
    recordType: "council_bill";
    evidenceRole: "narrative_context_only";
  };
}

export interface MemberBillRepository {
  searchMemberBills(input: {
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
  }): Promise<RepositoryResult<MemberBillHit> & { members: CouncilMemberSummary[] }>;
}

export interface SourceLocatorContext {
  entityType: string;
  entityKey: string;
  pageNumber: number | null;
  rowNumber: number | null;
  sectionName: string | null;
  locatorText: string | null;
  excerpt?: string;
}

export interface SourceContext {
  source: SourceRef;
  locators: SourceLocatorContext[];
  aliases?: string[];
}

export interface SourceRepository {
  getSourceContexts(sourceIds: string[]): Promise<RepositoryResult<SourceContext>>;
}

export interface ClaimRepository {
  findPopulationValue(input: {
    region: string;
    year: number;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<RepositoryResult<PopulationRecord>>;
  findLocalTaxValue(input: {
    region: string;
    year: number;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<RepositoryResult<LocalTaxRecord>>;
}

export interface AuditEvent {
  toolName: string;
  startedAt: Date;
  finishedAt: Date;
  success: boolean;
  dataStatuses: string[];
  resultCount: number;
  requestHash: string;
  requestMetadata: Record<string, unknown>;
  correlationId: string | null;
  errorClass: string | null;
}

export interface RepositoryReadiness {
  ready: boolean;
  mode: "memory" | "postgres";
  detail?: string;
}

export interface StorageCapacitySummary {
  generatedAt: string;
  counts: {
    currentChunks: number;
    staleChunks: number;
    currentEmbeddings: number;
    staleEmbeddings: number;
    currentPages: number;
    stalePages: number;
    expiredAuditRows: number;
  };
  sizes: {
    databaseBytes: number;
    documentChunkBytes: number;
    documentChunkIndexBytes: number;
    embeddingBytes: number;
    embeddingIndexBytes: number;
    documentPageBytes: number;
    documentPageIndexBytes: number;
  };
  versions: Array<{
    versionKey: string;
    approvalState: "candidate" | "approved" | "retired";
    chunks: number;
    currentChunks: number;
    embeddings: number;
    documents: number;
  }>;
  settings: Record<string, string>;
  warnings: string[];
}

/**
 * Live shape of one catalogued dataset.
 *
 * Everything here is measured at query time. The static catalog deliberately
 * does not hard-code year ranges or row counts, because a stale coverage claim
 * would be an unsourced assertion — exactly what the rest of the system refuses
 * to produce.
 */
export interface DatasetCoverage {
  datasetId: string;
  /** False when the dataset has no rows the caller is allowed to see. */
  available: boolean;
  rowCount: number;
  yearRange: { start: number; end: number } | null;
  regionCount: number;
  /** Sample of covered regions, capped so the response stays promptable. */
  regions: string[];
  dataStatuses: DataStatus[];
  /** Most recent reference/observation date present, not the crawl time. */
  lastObservedAt: string | null;
  sources: SourceRef[];
  /** Set when coverage could not be measured, e.g. the demo store lacks the table. */
  note: string | null;
}

export interface CatalogRepository {
  getDatasetCoverage(datasetIds: string[]): Promise<DatasetCoverage[]>;
}

export interface DataRepository
  extends PopulationRepository,
    LocalTaxRepository,
    PolicyRepository,
    CouncilRepository,
    DocumentRepository,
    PressReleaseRepository,
    MemberBillRepository,
    SourceRepository,
    CatalogRepository,
    ClaimRepository {
  readonly mode: "memory" | "postgres";
  readiness(): Promise<RepositoryReadiness>;
  storageCapacity(): Promise<StorageCapacitySummary | null>;
  writeAudit(event: AuditEvent): Promise<void>;
  close(): Promise<void>;
}

/** Keeps catalog responses small enough to paste into a prompt. */
const MAX_COVERAGE_REGIONS = 30;

function uniqueStatuses(values: DataStatus[]): DataStatus[] {
  return [...new Set(values)];
}

export class InMemoryDataRepository implements DataRepository {
  readonly mode = "memory" as const;
  private readonly sourceMap: Map<string, SourceRef>;

  constructor(private readonly store: DemoDataStore) {
    this.sourceMap = new Map(store.sources.map((source) => [source.sourceId, source]));
  }

  private result<T extends { sourceId: string; dataStatus: DataStatus }>(
    records: T[]
  ): RepositoryResult<T> {
    const sources = [
      ...new Set(records.map((record) => record.sourceId))
    ]
      .map((sourceId) => this.sourceMap.get(sourceId))
      .filter((source): source is SourceRef => Boolean(source));
    return {
      records,
      sources,
      dataStatuses: uniqueStatuses(records.map((record) => record.dataStatus))
    };
  }

  async getPopulationTrend(input: {
    region?: string;
    startYear: number;
    endYear: number;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<RepositoryResult<PopulationRecord>> {
    return this.result(
      this.store.population.filter(
        (row) =>
          (!input.region ||
            row.regionName.normalize("NFC").includes(input.region.normalize("NFC"))) &&
          row.year >= input.startYear &&
          row.year <= input.endYear &&
          input.dataStatuses.includes(row.dataStatus as FactDataStatus)
      )
    );
  }

  async getLocalTaxTrend(input: {
    region?: string;
    startYear: number;
    endYear: number;
    taxCategory: string;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<RepositoryResult<LocalTaxRecord>> {
    const filtered = this.store.taxes.filter(
      (row) =>
        (!input.region ||
          row.regionName.normalize("NFC").includes(input.region.normalize("NFC"))) &&
        row.fiscalYear >= input.startYear &&
        row.fiscalYear <= input.endYear &&
        row.taxCategory === input.taxCategory &&
        input.dataStatuses.includes(row.dataStatus as FactDataStatus)
    );
    const selected = new Map<string, LocalTaxRecord>();
    for (const row of filtered) {
      const key = `${row.regionId}:${row.fiscalYear}:${row.taxCategory}`;
      const existing = selected.get(key);
      if (
        !existing ||
        (existing.dataStatus === "demo_sample" &&
          row.dataStatus === "official_observed")
      ) {
        selected.set(key, row);
      }
    }
    return this.result([...selected.values()]);
  }

  async findPolicies(input: {
    region: string;
    query: string;
    dataStatuses: readonly FactDataStatus[];
    limit: number;
  }): Promise<RepositoryResult<PolicyRecord>> {
    const query = input.query.normalize("NFC").toLowerCase();
    return this.result(
      this.store.policies
        .filter(
          (row) =>
            input.dataStatuses.includes(row.dataStatus as FactDataStatus) &&
            (row.regionName === "경상북도" ||
              row.regionName.normalize("NFC").includes(input.region.normalize("NFC"))) &&
            [row.title, row.eligibilityText, row.support, ...row.industries]
              .join(" ")
              .normalize("NFC")
              .toLowerCase()
              .includes(query)
        )
        .slice(0, input.limit)
    );
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
    type Metadata = CouncilSearchHit["metadata"] & Record<string, unknown>;
    const documents: SearchDocument<Metadata>[] = this.store.council.map((record) => ({
      id: record.recordId,
      title: record.title,
      text: record.content,
      metadata: {
        region: record.regionName,
        council: record.council,
        meetingDate: record.meetingDate,
        sourceId: record.sourceId,
        locator: record.locator,
        dataStatus: record.dataStatus as FactDataStatus,
        recordType: "council_record"
      }
    }));
    const records = await hybridSearch(
      input.query,
      documents,
      new DisabledVectorAdapter<Metadata>(),
      {
        limit: input.limit,
        filter: (metadata) =>
          input.dataStatuses.includes(metadata.dataStatus) &&
          (!input.region || metadata.region.includes(input.region)) &&
          (!input.council || metadata.council.includes(input.council)) &&
          (!input.dateFrom || metadata.meetingDate >= input.dateFrom) &&
          (!input.dateTo || metadata.meetingDate <= input.dateTo)
      }
    );
    const hits: CouncilSearchHit[] = records.map((record) => ({
      id: record.id,
      title: record.title,
      text: record.text,
      score: record.score,
      matchedTerms: record.matchedTerms,
      metadata: record.metadata
    }));
    const sources = [
      ...new Set(hits.map((record) => record.metadata.sourceId))
    ]
      .map((sourceId) => this.sourceMap.get(sourceId))
      .filter((source): source is SourceRef => Boolean(source));
    return {
      records: hits,
      sources,
      dataStatuses: uniqueStatuses(hits.map((record) => record.metadata.dataStatus))
    };
  }

  /**
   * The in-memory store carries no press releases; they only exist in the
   * crawled PostgreSQL dataset.
   */
  async searchPressReleases(_input: {
    query: string;
    region?: string;
    department?: string;
    dateFrom?: string;
    dateTo?: string;
    limit: number;
  }): Promise<RepositoryResult<PressReleaseHit>> {
    return { records: [], sources: [], dataStatuses: [] };
  }

  /**
   * The in-memory store carries no council roster; 경상북도의회 members and bills
   * only exist in the crawled PostgreSQL dataset.
   */
  async searchMemberBills(_input: {
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
    return { records: [], sources: [], dataStatuses: [], members: [] };
  }

  async searchDocuments(_input: {
    query: string;
    region?: string;
    organization?: string;
    documentTypes?: string[];
    dateFrom?: string;
    dateTo?: string;
    limit: number;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<RepositoryResult<DocumentSearchHit>> {
    return { records: [], sources: [], dataStatuses: [] };
  }

  async getPolicyDocumentCoverage(
    _years: number[]
  ): Promise<RepositoryResult<PolicyDocumentCoverage>> {
    return { records: [], sources: [], dataStatuses: [] };
  }

  async getSourceContexts(
    sourceIds: string[]
  ): Promise<RepositoryResult<SourceContext>> {
    const contexts = sourceIds
      .map((sourceId) => this.sourceMap.get(sourceId))
      .filter((source): source is SourceRef => Boolean(source))
      .map((source) => ({
        source,
        aliases: [source.sourceId],
        locators: [
          {
            entityType: "source",
            entityKey: source.sourceId,
            pageNumber: null,
            rowNumber: null,
            sectionName: null,
            locatorText: source.locator ?? null
          }
        ]
      }));
    return {
      records: contexts,
      sources: contexts.map((context) => context.source),
      dataStatuses: uniqueStatuses(contexts.map((context) => context.source.dataStatus))
    };
  }

  async findPopulationValue(input: {
    region: string;
    year: number;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<RepositoryResult<PopulationRecord>> {
    return this.getPopulationTrend({
      ...input,
      startYear: input.year,
      endYear: input.year
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
    return { ready: true, mode: this.mode };
  }

  /**
   * Coverage for the demo store. Datasets that only exist in Postgres report
   * `available: false` with a note rather than an empty range, so an agent can
   * tell "this deployment has no such data" apart from "this data is empty".
   */
  async getDatasetCoverage(datasetIds: string[]): Promise<DatasetCoverage[]> {
    const build = <T>(
      datasetId: string,
      rows: T[],
      year: (row: T) => number,
      regionName: (row: T) => string,
      sourceId: (row: T) => string,
      dataStatus: (row: T) => DataStatus
    ): DatasetCoverage => {
      const years = rows.map(year).filter((value) => Number.isFinite(value));
      const regions = [...new Set(rows.map(regionName))];
      const sources = [...new Set(rows.map(sourceId))]
        .map((id) => this.sourceMap.get(id))
        .filter((source): source is SourceRef => Boolean(source));
      return {
        datasetId,
        available: rows.length > 0,
        rowCount: rows.length,
        yearRange:
          years.length > 0
            ? { start: Math.min(...years), end: Math.max(...years) }
            : null,
        regionCount: regions.length,
        regions: regions.slice(0, MAX_COVERAGE_REGIONS),
        dataStatuses: uniqueStatuses(rows.map(dataStatus)),
        lastObservedAt:
          years.length > 0 ? `${Math.max(...years)}-12-31` : null,
        sources,
        note: null
      };
    };

    const unavailable = (datasetId: string, note: string): DatasetCoverage => ({
      datasetId,
      available: false,
      rowCount: 0,
      yearRange: null,
      regionCount: 0,
      regions: [],
      dataStatuses: [],
      lastObservedAt: null,
      sources: [],
      note
    });

    return datasetIds.map((datasetId) => {
      switch (datasetId) {
        case "population_observation":
          return build(
            datasetId,
            this.store.population,
            (row) => row.year,
            (row) => row.regionName,
            (row) => row.sourceId,
            (row) => row.dataStatus
          );
        case "local_tax_revenue":
          return build(
            datasetId,
            this.store.taxes,
            (row) => row.fiscalYear,
            (row) => row.regionName,
            (row) => row.sourceId,
            (row) => row.dataStatus
          );
        case "policy_program":
          return build(
            datasetId,
            this.store.policies,
            () => Number.NaN,
            (row) => row.regionName,
            (row) => row.sourceId,
            (row) => row.dataStatus
          );
        case "council_record":
          return build(
            datasetId,
            this.store.council,
            (row) => Number(row.meetingDate.slice(0, 4)),
            (row) => row.regionName,
            (row) => row.sourceId,
            (row) => row.dataStatus
          );
        default:
          return unavailable(
            datasetId,
            "이 데이터셋은 PostgreSQL 모드에서만 제공됩니다. 현재는 메모리 데모 저장소입니다."
          );
      }
    });
  }

  async storageCapacity(): Promise<null> {
    return null;
  }

  async writeAudit(_event: AuditEvent): Promise<void> {}

  async close(): Promise<void> {}
}
