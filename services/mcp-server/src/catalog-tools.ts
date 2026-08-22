import {
  DATASET_CATALOG,
  datasetSearchText,
  getDatasetDefinition,
  isDatasetRelevant,
  relationshipsFor,
  type DatasetDefinition
} from "@gb/domain";
import { lexicalSearch, tokenizeKorean } from "@gb/retrieval";
import type { CatalogRepository, DatasetCoverage } from "./repository.js";

export interface DatasetSearchHit {
  datasetId: string;
  title: string;
  description: string;
  grain: string;
  evidenceRole: string;
  score: number;
  /** Query terms that caused the match, so the agent can explain its choice. */
  matchedTerms: string[];
  measures: Array<{ name: string; label: string; unit: string | null }>;
  joinKeys: string[];
  tools: Array<{ tool: string; answers: string; requiredArguments: string[] }>;
  coverage: DatasetCoverage;
}

/**
 * Datasets a query might mean, ranked.
 *
 * Ranking is lexical over the catalog's own text. That is deliberate: the
 * catalog is small (single-digit datasets) and hand-curated, so a transparent
 * term match that can name *which words matched* is more useful — and more
 * auditable — than an opaque embedding score over seven documents.
 */
export async function searchDatasets(
  repository: CatalogRepository,
  input: {
    query: string;
    joinableWith?: string;
    evidenceRole?: string;
    limit: number;
  }
): Promise<{ hits: DatasetSearchHit[]; notes: string[] }> {
  const notes: string[] = [];

  let candidates: readonly DatasetDefinition[] = DATASET_CATALOG;

  if (input.joinableWith) {
    const anchor = getDatasetDefinition(input.joinableWith);
    if (!anchor) {
      notes.push(
        `joinableWith='${input.joinableWith}'는 카탈로그에 없는 데이터셋이라 조인 필터를 적용하지 않았습니다.`
      );
    } else {
      const joinable = new Set(
        relationshipsFor(anchor.datasetId).map((relationship) => relationship.to)
      );
      candidates = candidates.filter((dataset) => joinable.has(dataset.datasetId));
      notes.push(
        `${anchor.title}과(와) 선언된 조인 관계가 있는 데이터셋으로만 좁혔습니다.`
      );
    }
  }

  if (input.evidenceRole) {
    candidates = candidates.filter(
      (dataset) => dataset.evidenceRole === input.evidenceRole
    );
    if (input.evidenceRole === "observed_fact") {
      notes.push(
        "관측된 사실만 요청했으므로 보도자료·회의록 같은 서술 자료는 제외했습니다."
      );
    }
  }

  // Gate on the curated vocabulary first, then rank. Ranking alone is not a
  // relevance decision: lexicalSearch scores character bigrams, so an unrelated
  // query still produces a nonzero score against some dataset.
  const relevant = candidates.filter((dataset) =>
    isDatasetRelevant(dataset, input.query)
  );

  const ranked = lexicalSearch(
    input.query,
    relevant.map((dataset) => ({
      id: dataset.datasetId,
      title: dataset.title,
      text: datasetSearchText(dataset),
      metadata: { datasetId: dataset.datasetId }
    })),
    { limit: input.limit }
  );

  // A query with no catalog term overlap should return nothing rather than an
  // arbitrary top-N: silently answering from an unrelated dataset is the exact
  // failure this tool exists to prevent.
  if (ranked.length === 0) {
    notes.push(
      "질의어가 어떤 데이터셋 설명과도 겹치지 않아 후보를 제시하지 않았습니다. 다른 표현으로 다시 시도하세요."
    );
    return { hits: [], notes };
  }

  const coverages = await repository.getDatasetCoverage(
    ranked.map((hit) => hit.id)
  );
  const coverageById = new Map(
    coverages.map((coverage) => [coverage.datasetId, coverage])
  );

  const hits = ranked.map((hit) => {
    const dataset = getDatasetDefinition(hit.id)!;
    return {
      datasetId: dataset.datasetId,
      title: dataset.title,
      description: dataset.description,
      grain: dataset.grain,
      evidenceRole: dataset.evidenceRole,
      score: hit.score,
      matchedTerms: hit.matchedTerms,
      measures: dataset.measures.map((measure) => ({
        name: measure.name,
        label: measure.label,
        unit: measure.unit
      })),
      joinKeys: dataset.dimensions
        .filter((dimension) => dimension.joinKey)
        .map((dimension) => dimension.name),
      tools: dataset.tools.map((binding) => ({ ...binding })),
      coverage:
        coverageById.get(dataset.datasetId) ??
        emptyCoverage(dataset.datasetId, "커버리지를 조회하지 못했습니다.")
    } satisfies DatasetSearchHit;
  });

  const unavailable = hits.filter((hit) => !hit.coverage.available);
  if (unavailable.length > 0) {
    notes.push(
      `${unavailable
        .map((hit) => hit.title)
        .join(", ")}은(는) 현재 배포에 적재된 행이 없어 질의해도 결과가 비어 있습니다.`
    );
  }

  return { hits, notes };
}

export interface DatasetProfile {
  datasetId: string;
  title: string;
  description: string;
  grain: string;
  evidenceRole: string;
  measures: DatasetDefinition["measures"];
  dimensions: DatasetDefinition["dimensions"];
  tools: DatasetDefinition["tools"];
  usageRules: string[];
  relationships: Array<{
    datasetId: string;
    title: string;
    joinKeys: string[];
    rationale: string;
    caveats: string[];
  }>;
  coverage: DatasetCoverage | null;
}

/** Everything an agent needs to decide whether and how to query one dataset. */
export async function describeDataset(
  repository: CatalogRepository,
  input: { datasetId: string; includeCoverage: boolean }
): Promise<DatasetProfile> {
  const dataset = getDatasetDefinition(input.datasetId);
  if (!dataset) {
    throw new Error(
      `알 수 없는 데이터셋입니다: ${input.datasetId}. search_datasets로 먼저 후보를 확인하세요.`
    );
  }
  const coverage = input.includeCoverage
    ? ((await repository.getDatasetCoverage([dataset.datasetId]))[0] ??
      emptyCoverage(dataset.datasetId, "커버리지를 조회하지 못했습니다."))
    : null;

  return {
    datasetId: dataset.datasetId,
    title: dataset.title,
    description: dataset.description,
    grain: dataset.grain,
    evidenceRole: dataset.evidenceRole,
    measures: dataset.measures,
    dimensions: dataset.dimensions,
    tools: dataset.tools,
    usageRules: dataset.usageRules,
    relationships: relationshipsFor(dataset.datasetId).map((relationship) => ({
      datasetId: relationship.to,
      title: getDatasetDefinition(relationship.to)?.title ?? relationship.to,
      joinKeys: relationship.joinKeys,
      rationale: relationship.rationale,
      caveats: relationship.caveats
    })),
    coverage
  };
}

/** Terms from the query that exist in the catalog at all, for diagnostics. */
export function catalogVocabularyOverlap(query: string): string[] {
  const vocabulary = new Set(
    DATASET_CATALOG.flatMap((dataset) => tokenizeKorean(datasetSearchText(dataset)))
  );
  return tokenizeKorean(query).filter((term) => vocabulary.has(term));
}

function emptyCoverage(datasetId: string, note: string): DatasetCoverage {
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
    note
  };
}
