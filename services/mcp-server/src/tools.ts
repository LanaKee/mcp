import {
  comparePopulationAndTax,
  comparisonInputSchema,
  councilSearchInputSchema,
  draftPublicDocument,
  draftPublicDocumentInputSchema,
  evaluatePolicyEligibility,
  localTaxTrendInputSchema,
  normalizeRegionName,
  policySearchInputSchema,
  populationTrendInputSchema,
  sourceContextInputSchema,
  summarizeTrend,
  verifyClaimInputSchema,
  type SourceRef
} from "@gb/domain";
import {
  DisabledVectorAdapter,
  hybridSearch,
  type SearchDocument
} from "@gb/retrieval";
import type { z } from "zod";
import type { DemoDataStore } from "./data-store.js";

export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  description: string;
  inputSchema: JsonSchema;
  parse: (input: unknown) => unknown;
  execute: (input: never) => Promise<Record<string, unknown>>;
}

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[]
): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});

function dataStatus(sources: SourceRef[]) {
  return sources.every((source) => source.dataStatus === "official_observed")
    ? "official_observed"
    : "demo_sample";
}

export function createToolRegistry(store: DemoDataStore): Record<string, ToolDefinition> {
  const sourceMap = new Map(store.sources.map((source) => [source.sourceId, source]));
  const sourcesFor = (ids: Iterable<string>) =>
    [...new Set(ids)]
      .map((id) => sourceMap.get(id))
      .filter((source): source is SourceRef => Boolean(source));

  const definitions: Record<string, ToolDefinition> = {};
  const add = <T>(
    name: string,
    description: string,
    schema: z.ZodType<T>,
    inputSchema: JsonSchema,
    execute: (input: T) => Promise<Record<string, unknown>> | Record<string, unknown>
  ) => {
    definitions[name] = {
      description,
      inputSchema,
      parse: (input) => schema.parse(input),
      execute: execute as (input: never) => Promise<Record<string, unknown>>
    };
  };

  const year = { type: "integer", minimum: 1900, maximum: 2100 };
  const region = { type: "string", minLength: 1, maxLength: 80 };

  add(
    "get_population_trend",
    "지역별 인구 시계열과 증감률을 조회합니다.",
    populationTrendInputSchema,
    objectSchema({ region, startYear: year, endYear: year }, [
      "region",
      "startYear",
      "endYear"
    ]),
    (input) => {
      const rows = store.population
        .filter(
          (record) =>
            normalizeRegionName(record.regionName) === normalizeRegionName(input.region) &&
            record.year >= input.startYear &&
            record.year <= input.endYear
        )
        .sort((a, b) => a.year - b.year);
      if (rows.length === 0) throw new Error("해당 지역·기간의 인구 데이터가 없습니다.");
      const sources = sourcesFor(rows.map((row) => row.sourceId));
      return {
        data_status: dataStatus(sources),
        result: {
          region: rows[0]!.regionName,
          unit: "명",
          points: rows.map((row) => ({ year: row.year, value: row.populationTotal })),
          summary: summarizeTrend(
            rows.map((row) => ({
              year: row.year,
              value: row.populationTotal,
              sourceId: row.sourceId
            }))
          )
        },
        sources,
        limitations: ["데모 샘플은 공식 통계가 아니며 실제 의사결정에 사용할 수 없습니다."]
      };
    }
  );

  add(
    "get_local_tax_revenue_trend",
    "지역별 지방세 세수 시계열과 증감률을 조회합니다. 국세는 다루지 않습니다.",
    localTaxTrendInputSchema,
    objectSchema(
      {
        region,
        startYear: year,
        endYear: year,
        taxCategory: { type: "string", default: "합계" }
      },
      ["region", "startYear", "endYear"]
    ),
    (input) => {
      const rows = store.taxes
        .filter(
          (record) =>
            normalizeRegionName(record.regionName) === normalizeRegionName(input.region) &&
            record.taxCategory === input.taxCategory &&
            record.fiscalYear >= input.startYear &&
            record.fiscalYear <= input.endYear
        )
        .sort((a, b) => a.fiscalYear - b.fiscalYear);
      if (rows.length === 0) throw new Error("해당 지역·기간의 지방세 데이터가 없습니다.");
      const sources = sourcesFor(rows.map((row) => row.sourceId));
      return {
        data_status: dataStatus(sources),
        result: {
          region: rows[0]!.regionName,
          tax_category: input.taxCategory,
          accounting_basis: rows[0]!.accountingBasis,
          unit: "원",
          points: rows.map((row) => ({
            year: row.fiscalYear,
            value: row.revenueAmountWon
          })),
          summary: summarizeTrend(
            rows.map((row) => ({
              year: row.fiscalYear,
              value: row.revenueAmountWon,
              sourceId: row.sourceId
            }))
          )
        },
        sources,
        limitations: [
          "현재 지방세 값은 기능 시연용 가상 결산 샘플이며 공식 수치가 아닙니다."
        ]
      };
    }
  );

  add(
    "compare_population_and_tax",
    "시군별 인구 감소와 지방세 증가를 같은 기간으로 비교합니다.",
    comparisonInputSchema,
    objectSchema(
      {
        startYear: year,
        endYear: year,
        regions: { type: "array", items: region, maxItems: 30 }
      },
      ["startYear", "endYear"]
    ),
    (input) => {
      const comparison = comparePopulationAndTax(
        store.population,
        store.taxes,
        input.startYear,
        input.endYear,
        input.regions
      );
      const sources = sourcesFor([
        ...store.population.map((row) => row.sourceId),
        ...store.taxes.map((row) => row.sourceId)
      ]);
      return {
        data_status: dataStatus(sources),
        result: {
          period: { start_year: input.startYear, end_year: input.endYear },
          matches: comparison.filter((item) => item.matches),
          all_regions: comparison
        },
        sources,
        limitations: [
          "동시 변화는 상관관계만 보여 주며 인과관계를 입증하지 않습니다.",
          "지방세 수치는 기능 시연용 가상 샘플입니다."
        ]
      };
    }
  );

  add(
    "search_policies",
    "지역·나이·관심 분야·창업 단계에 맞는 정책과 자격 판단 근거를 찾습니다.",
    policySearchInputSchema,
    objectSchema(
      {
        region,
        age: { type: "integer", minimum: 0, maximum: 120 },
        query: { type: "string", minLength: 1, maxLength: 200 },
        stage: { type: "string", maxLength: 80 },
        asOfDate: { type: "string", format: "date" }
      },
      ["region", "age", "query"]
    ),
    (input) => {
      const matches = store.policies
        .map((policy) => evaluatePolicyEligibility(policy, input))
        .sort((a, b) => b.score - a.score);
      const sources = sourcesFor(matches.map((match) => match.policy.sourceId));
      return {
        data_status: dataStatus(sources),
        result: { matches },
        sources,
        limitations: [
          "정책은 데모용 가상 공고입니다. 실제 신청 자격·기간은 공식 공고에서 확인해야 합니다."
        ]
      };
    }
  );

  add(
    "search_council_records",
    "한글 부분일치와 날짜·지역·의회 필터로 의회 안건 및 회의자료를 검색합니다.",
    councilSearchInputSchema,
    objectSchema(
      {
        query: { type: "string", minLength: 1, maxLength: 300 },
        region,
        council: { type: "string", maxLength: 100 },
        dateFrom: { type: "string", format: "date" },
        dateTo: { type: "string", format: "date" },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 5 }
      },
      ["query"]
    ),
    async (input) => {
      type Metadata = {
        region: string;
        council: string;
        meetingDate: string;
        sourceId: string;
        locator: string;
        dataStatus: string;
        [key: string]: unknown;
      };
      const documents: SearchDocument<Metadata>[] = store.council.map((record) => ({
        id: record.recordId,
        title: record.title,
        text: record.content,
        metadata: {
          region: record.regionName,
          council: record.council,
          meetingDate: record.meetingDate,
          sourceId: record.sourceId,
          locator: record.locator,
          dataStatus: record.dataStatus
        }
      }));
      const matches = await hybridSearch(
        input.query,
        documents,
        new DisabledVectorAdapter<Metadata>(),
        {
          limit: input.limit,
          filter: (metadata) =>
            (!input.region ||
              normalizeRegionName(metadata.region).includes(
                normalizeRegionName(input.region)
              )) &&
            (!input.council || metadata.council.includes(input.council)) &&
            (!input.dateFrom || metadata.meetingDate >= input.dateFrom) &&
            (!input.dateTo || metadata.meetingDate <= input.dateTo)
        }
      );
      const sources = sourcesFor(matches.map((match) => String(match.metadata.sourceId)));
      return {
        data_status: dataStatus(sources),
        result: { matches },
        sources,
        limitations: [
          "현재 검색 결과는 가상 요약 샘플입니다.",
          "벡터 어댑터 경계는 구현되어 있으나 기본 실행은 외부 임베딩 없이 어휘 검색만 사용합니다."
        ]
      };
    }
  );

  add(
    "verify_claim_with_data",
    "인구 또는 지방세 수치 주장을 정규화 데이터의 특정 연도 값과 대조합니다.",
    verifyClaimInputSchema,
    objectSchema(
      {
        metric: { type: "string", enum: ["population", "local_tax"] },
        region,
        year,
        claimedValue: { type: "number", minimum: 0 },
        tolerancePercent: { type: "number", minimum: 0, maximum: 100, default: 1 }
      },
      ["metric", "region", "year", "claimedValue"]
    ),
    (input) => {
      const row =
        input.metric === "population"
          ? store.population.find(
              (candidate) =>
                normalizeRegionName(candidate.regionName) ===
                  normalizeRegionName(input.region) && candidate.year === input.year
            )
          : store.taxes.find(
              (candidate) =>
                normalizeRegionName(candidate.regionName) ===
                  normalizeRegionName(input.region) &&
                candidate.fiscalYear === input.year &&
                candidate.taxCategory === "합계"
            );
      if (!row) throw new Error("검증에 필요한 기준 데이터가 없습니다.");
      const actualValue =
        "populationTotal" in row ? row.populationTotal : row.revenueAmountWon;
      const difference = input.claimedValue - actualValue;
      const tolerancePercent = input.tolerancePercent ?? 1;
      const differencePercent =
        actualValue === 0 ? 0 : Number(((Math.abs(difference) / actualValue) * 100).toFixed(3));
      const sources = sourcesFor([row.sourceId]);
      return {
        data_status: dataStatus(sources),
        result: {
          verdict:
            differencePercent <= tolerancePercent ? "consistent" : "inconsistent",
          claimed_value: input.claimedValue,
          actual_value: actualValue,
          difference,
          difference_percent: differencePercent,
          tolerance_percent: tolerancePercent
        },
        sources,
        limitations: ["검증 결과의 신뢰도는 기준 데이터의 data_status에 좌우됩니다."]
      };
    }
  );

  add(
    "get_source_context",
    "source_id로 출처 메타데이터와 원문 위치 정보를 조회합니다.",
    sourceContextInputSchema,
    objectSchema(
      { sourceIds: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } } },
      ["sourceIds"]
    ),
    (input) => {
      const sources = sourcesFor(input.sourceIds);
      return {
        data_status: dataStatus(sources),
        result: {
          requested: input.sourceIds,
          found: sources,
          missing: input.sourceIds.filter((id) => !sourceMap.has(id))
        },
        sources,
        limitations: ["catalog_only PDF는 원문 내용이 아니라 파일 위치와 해시만 제공합니다."]
      };
    }
  );

  add(
    "draft_public_document",
    "제공된 검증 완료 분석·근거·출처만 사용해 행정문서 초안을 작성합니다.",
    draftPublicDocumentInputSchema,
    objectSchema(
      {
        documentType: {
          type: "string",
          enum: ["information_request", "participatory_budget"]
        },
        title: { type: "string", minLength: 1, maxLength: 200 },
        requesterContext: { type: "string", maxLength: 1000 },
        verifiedAnalysis: { type: "object" }
      },
      ["documentType", "title", "verifiedAnalysis"]
    ),
    (input) => {
      const result = draftPublicDocument(input);
      return {
        data_status: result.dataStatus,
        result,
        sources: input.verifiedAnalysis.sources,
        limitations: [
          ...input.verifiedAnalysis.limitations,
          "제출 전 최신 서식과 담당 기관 요구사항을 확인해야 합니다."
        ]
      };
    }
  );

  return definitions;
}

export async function executeTool(
  registry: Record<string, ToolDefinition>,
  name: string,
  input: unknown
): Promise<Record<string, unknown>> {
  const tool = registry[name];
  if (!tool) throw new Error(`지원하지 않는 도구입니다: ${name}`);
  const parsed = tool.parse(input);
  return tool.execute(parsed as never);
}
