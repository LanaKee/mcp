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
  "official_observed",
  "demo_sample"
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
  };
}

export interface DocumentRepository {
  searchDocuments(input: {
    query: string;
    region?: string;
    organization?: string;
    dateFrom?: string;
    dateTo?: string;
    limit: number;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<RepositoryResult<DocumentSearchHit>>;
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
  errorClass: string | null;
}

export interface RepositoryReadiness {
  ready: boolean;
  mode: "memory" | "postgres";
  detail?: string;
}

export interface DataRepository
  extends PopulationRepository,
    LocalTaxRepository,
    PolicyRepository,
    CouncilRepository,
    DocumentRepository,
    SourceRepository,
    ClaimRepository {
  readonly mode: "memory" | "postgres";
  readiness(): Promise<RepositoryReadiness>;
  writeAudit(event: AuditEvent): Promise<void>;
  close(): Promise<void>;
}

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
    return this.result(
      this.store.taxes.filter(
        (row) =>
          (!input.region ||
            row.regionName.normalize("NFC").includes(input.region.normalize("NFC"))) &&
          row.fiscalYear >= input.startYear &&
          row.fiscalYear <= input.endYear &&
          row.taxCategory === input.taxCategory &&
          input.dataStatuses.includes(row.dataStatus as FactDataStatus)
      )
    );
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

  async searchDocuments(_input: {
    query: string;
    region?: string;
    organization?: string;
    dateFrom?: string;
    dateTo?: string;
    limit: number;
    dataStatuses: readonly FactDataStatus[];
  }): Promise<RepositoryResult<DocumentSearchHit>> {
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

  async writeAudit(_event: AuditEvent): Promise<void> {}

  async close(): Promise<void> {}
}
