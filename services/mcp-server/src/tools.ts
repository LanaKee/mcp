import { createHash, randomBytes } from "node:crypto";
import {
  analyzeComparableTrend,
  comparePopulationAndTax,
  comparisonInputSchema,
  councilSearchInputSchema,
  draftPublicDocument,
  draftPublicDocumentInputSchema,
  evaluatePolicyEligibility,
  localTaxTrendInputSchema,
  policySearchInputSchema,
  localTaxTrendPoints,
  populationTrendPoints,
  populationTrendInputSchema,
  sourceContextInputSchema,
  verifyClaimInputSchema,
  type DataStatus,
  type LocalTaxRecord,
  type SourceRef
} from "@gb/domain";
import type { z } from "zod";
import {
  DEFAULT_FACT_STATUSES,
  type DataRepository,
  type FactDataStatus
} from "./repository.js";

export type JsonSchema = Record<string, unknown>;
export type ResponseDataStatus = DataStatus | "mixed" | "empty";

export interface ToolResponse<TResult = unknown> {
  data_status: ResponseDataStatus;
  data_statuses: DataStatus[];
  result: TResult;
  sources: SourceRef[];
  limitations: string[];
  [key: string]: unknown;
}

export interface ToolDefinition {
  description: string;
  inputSchema: JsonSchema;
  parse: (input: unknown) => unknown;
  execute: (input: never) => Promise<ToolResponse>;
}

export interface ToolRegistry {
  tools: Record<string, ToolDefinition>;
  repository: DataRepository;
}

export interface ToolExecutionContext {
  correlationId?: string;
  signal?: AbortSignal;
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

const factStatusProperty = {
  type: "array",
  minItems: 1,
  maxItems: 2,
  uniqueItems: true,
  items: { type: "string", enum: ["official_observed", "demo_sample"] }
};

function statuses(input: unknown): FactDataStatus[] {
  return (
    input as { dataStatuses?: FactDataStatus[] }
  ).dataStatuses ?? [...DEFAULT_FACT_STATUSES];
}

function responseStatus(values: DataStatus[]): ResponseDataStatus {
  const unique = [...new Set(values)];
  if (unique.length === 0) return "empty";
  return unique.length === 1 ? unique[0]! : "mixed";
}

function mergeSources(...groups: SourceRef[][]): SourceRef[] {
  return [...new Map(groups.flat().map((source) => [source.sourceId, source])).values()];
}

function targetedPolicyYear(input: {
  query: string;
  asOfDate?: string;
}): number | null {
  if (input.asOfDate) return Number(input.asOfDate.slice(0, 4));
  const match = input.query.match(/\b(20(?:20|21|22|23|24|25|26))\b/u);
  return match ? Number(match[1]) : null;
}

function statusLimitations(values: DataStatus[]): string[] {
  const limitations: string[] = [];
  if (values.includes("demo_sample")) {
    limitations.push("결과에 demo_sample이 포함되어 공식 사실로 인용할 수 없습니다.");
  }
  if (values.includes("official_observed")) {
    limitations.push("official_observed도 원출처와 기준일을 함께 확인해야 합니다.");
  }
  return limitations;
}

function taxCoverageLimitations(rows: LocalTaxRecord[]): string[] {
  const statuses = [...new Set(rows.map((row) => row.dataStatus))];
  if (
    statuses.length === 1 &&
    statuses[0] === "demo_sample"
  ) {
    return [
      "요청한 지역·연도에는 공식 지방세가 없어 demo_sample만 반환했습니다."
    ];
  }

  if (statuses.length > 1) {
    return [
      "공식 자료가 없는 연도만 demo_sample을 사용했으며 각 점의 dataStatus를 반드시 구분해야 합니다."
    ];
  }
  return [];
}

function summaryUnavailableMessage(
  reason: "insufficient_points" | "incomparable_sources"
): string {
  return reason === "incomparable_sources"
    ? "상태·인구 측정기준/날짜 정밀도·회계기준·금액 의미·원천 grain·단위가 다른 점을 가로질러 증감률을 계산하지 않았습니다."
    : "비교 가능한 점이 두 건 미만이어서 증감률을 계산하지 않았습니다.";
}

export function createToolRegistry(repository: DataRepository): ToolRegistry {
  const definitions: Record<string, ToolDefinition> = {};
  const add = <T>(
    name: string,
    description: string,
    schema: z.ZodType<T>,
    inputSchema: JsonSchema,
    execute: (input: T) => Promise<ToolResponse> | ToolResponse
  ) => {
    definitions[name] = {
      description,
      inputSchema,
      parse: (input) => schema.parse(input),
      execute: async (input) => execute(input as T)
    };
  };

  const year = { type: "integer", minimum: 1900, maximum: 2100 };
  const region = { type: "string", minLength: 1, maxLength: 80 };

  add(
    "get_population_trend",
    "지역별 인구 시계열과 증감률을 조회합니다.",
    populationTrendInputSchema,
    objectSchema(
      { region, startYear: year, endYear: year, dataStatuses: factStatusProperty },
      ["region", "startYear", "endYear"]
    ),
    async (input) => {
      const loaded = await repository.getPopulationTrend({
        ...input,
        dataStatuses: statuses(input)
      });
      const rows = loaded.records.sort((left, right) => left.year - right.year);
      if (rows.length === 0) throw new Error("해당 지역·기간의 인구 데이터가 없습니다.");
      const analysis = analyzeComparableTrend(populationTrendPoints(rows));
      return {
        data_status: responseStatus(loaded.dataStatuses),
        data_statuses: loaded.dataStatuses,
        result: {
          region: rows[0]!.regionName,
          unit: "명",
          points: rows.map((row) => ({
            year: row.year,
            value: row.populationTotal,
            sourceId: row.sourceId,
            dataStatus: row.dataStatus,
            measurementBasis: row.measurementBasis,
            referenceDatePrecision: row.referenceDatePrecision
          })),
          summary: analysis.summary,
          summary_unavailable_reason: analysis.summaryUnavailableReason,
          series_segments: analysis.segments
        },
        sources: loaded.sources,
        limitations: [
          ...(analysis.summaryUnavailableReason
            ? [summaryUnavailableMessage(analysis.summaryUnavailableReason)]
            : []),
          ...statusLimitations(loaded.dataStatuses)
        ]
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
        taxCategory: { type: "string", default: "합계" },
        dataStatuses: factStatusProperty
      },
      ["region", "startYear", "endYear"]
    ),
    async (input) => {
      const loaded = await repository.getLocalTaxTrend({
        ...input,
        taxCategory: input.taxCategory ?? "합계",
        dataStatuses: statuses(input)
      });
      const rows = loaded.records.sort(
        (left, right) => left.fiscalYear - right.fiscalYear
      );
      if (rows.length === 0) {
        throw new Error("해당 지역·기간의 지방세 데이터가 없습니다.");
      }
      const accountingBases = [...new Set(rows.map((row) => row.accountingBasis))];
      const amountSemantics = [
        ...new Set(rows.map((row) => row.amountSemantics).filter(Boolean))
      ];
      const sourceGrains = [
        ...new Set(rows.map((row) => row.sourceGrain).filter(Boolean))
      ];
      const analysis = analyzeComparableTrend(localTaxTrendPoints(rows));
      return {
        data_status: responseStatus(loaded.dataStatuses),
        data_statuses: loaded.dataStatuses,
        result: {
          region: rows[0]!.regionName,
          tax_category: input.taxCategory ?? "합계",
          accounting_basis:
            accountingBases.length === 1 ? accountingBases[0] : "mixed",
          amount_semantics:
            amountSemantics.length === 1 ? amountSemantics[0] : amountSemantics,
          source_grains: sourceGrains,
          unit: "원",
          points: rows.map((row) => ({
            year: row.fiscalYear,
            value: row.revenueAmountWon,
            sourceId: row.sourceId,
            dataStatus: row.dataStatus,
            accountingBasis: row.accountingBasis,
            amountSemantics: row.amountSemantics ?? null,
            sourceGrain: row.sourceGrain ?? null,
            sourceUnit: row.unitOriginal ?? null,
            sourceUnitMultiplier: row.unitMultiplier ?? null
          })),
          summary: analysis.summary,
          summary_unavailable_reason: analysis.summaryUnavailableReason,
          series_segments: analysis.segments
        },
        sources: loaded.sources,
        limitations: [
          "국세는 범위 밖입니다.",
          ...(analysis.summaryUnavailableReason
            ? [summaryUnavailableMessage(analysis.summaryUnavailableReason)]
            : []),
          ...taxCoverageLimitations(rows),
          ...statusLimitations(loaded.dataStatuses)
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
        regions: { type: "array", items: region, maxItems: 30 },
        dataStatuses: factStatusProperty
      },
      ["startYear", "endYear"]
    ),
    async (input) => {
      const dataStatuses = statuses(input);
      const [population, taxes] = await Promise.all([
        repository.getPopulationTrend({
          startYear: input.startYear,
          endYear: input.endYear,
          dataStatuses
        }),
        repository.getLocalTaxTrend({
          startYear: input.startYear,
          endYear: input.endYear,
          taxCategory: "합계",
          dataStatuses
        })
      ]);
      const comparison = comparePopulationAndTax(
        population.records,
        taxes.records,
        input.startYear,
        input.endYear,
        input.regions
      );
      const usedStatuses = [
        ...new Set([...population.dataStatuses, ...taxes.dataStatuses])
      ];
      const mixedTaxCoverage = comparison.some(
        (item) => item.taxDataStatuses.length > 1
      );
      const notEvaluable = comparison.filter((item) => !item.evaluable);
      return {
        data_status: responseStatus(usedStatuses),
        data_statuses: usedStatuses,
        result: {
          period: { start_year: input.startYear, end_year: input.endYear },
          matches: comparison.filter((item) => item.matches === true),
          not_evaluable: notEvaluable,
          all_regions: comparison
        },
        sources: mergeSources(population.sources, taxes.sources),
        limitations: [
          "동시 변화는 상관관계만 보여 주며 인과관계를 입증하지 않습니다.",
          ...(mixedTaxCoverage
            ? [
                "일부 지역 추세는 공식 자료가 없는 연도에만 demo_sample을 사용하며 상태 배열로 명시합니다."
              ]
            : []),
          ...(notEvaluable.length > 0
            ? [
                "비교 불가능하거나 비공식인 시계열에는 증감 방향과 일치 판정을 생성하지 않았습니다."
              ]
            : []),
          ...taxCoverageLimitations(taxes.records),
          ...statusLimitations(usedStatuses)
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
        asOfDate: { type: "string", format: "date" },
        dataStatuses: factStatusProperty
      },
      ["region", "age", "query"]
    ),
    async (input) => {
      const requestedStatuses = statuses(input);
      const targetYear = targetedPolicyYear(input);
      const coverage =
        targetYear === null
          ? { records: [], sources: [], dataStatuses: [] }
          : await repository.getPolicyDocumentCoverage([targetYear]);
      const loaded = await repository.findPolicies({
        region: input.region,
        query: input.query,
        dataStatuses: requestedStatuses,
        limit: 100
      });
      const officialDocuments = requestedStatuses.includes("official_observed")
        ? await repository.searchDocuments({
            query: input.query,
            documentTypes: ["provincial_work_plan"],
            dateFrom:
              targetYear === null ? undefined : `${targetYear}-01-01`,
            dateTo:
              targetYear === null ? undefined : `${targetYear}-12-31`,
            limit: 8,
            dataStatuses: ["official_observed"]
          })
        : { records: [], sources: [], dataStatuses: [] };
      const matches = loaded.records
        .map((policy) => evaluatePolicyEligibility(policy, input))
        .sort((left, right) => right.score - left.score);
      const usedStatuses = [
        ...new Set([
          ...loaded.dataStatuses,
          ...officialDocuments.dataStatuses,
          ...coverage.dataStatuses
        ])
      ];
      const unavailableCoverage = coverage.records.filter(
        (item) => !item.retrievalAvailable
      );
      return {
        data_status: responseStatus(usedStatuses),
        data_statuses: usedStatuses,
        result: {
          matches,
          official_document_passages: officialDocuments.records,
          policy_document_coverage: coverage.records
        },
        sources: mergeSources(
          loaded.sources,
          officialDocuments.sources,
          coverage.sources
        ),
        limitations: [
          "정책 신청 전 최신 공식 공고의 자격과 기간을 확인해야 합니다.",
          ...(matches.some(
            (match) => match.policy.dataStatus === "demo_sample"
          )
            ? [
                "matches의 demo_sample 자격 판단은 기능 예시이며 공식 정책 근거가 아닙니다."
              ]
            : []),
          ...(officialDocuments.records.length > 0
            ? [
                "official_document_passages는 공식 도정 업무계획의 페이지 인용이며, 자격·지원액을 구조화하거나 추론하지 않습니다."
              ]
            : []),
          ...(unavailableCoverage.length > 0
            ? [
                `${unavailableCoverage.map((item) => item.year).join(", ")}년도 도정 업무계획 원문은 존재하지만 기계 판독 가능한 본문이 없어 검색 근거로 제공하지 않습니다.`
              ]
            : []),
          ...statusLimitations(usedStatuses)
        ]
      };
    }
  );

  add(
    "search_council_records",
    "한글 부분일치와 날짜·지역·의회 필터로 의회 안건 및 PDF 페이지를 검색합니다.",
    councilSearchInputSchema,
    objectSchema(
      {
        query: { type: "string", minLength: 1, maxLength: 300 },
        region,
        council: { type: "string", maxLength: 100 },
        dateFrom: { type: "string", format: "date" },
        dateTo: { type: "string", format: "date" },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        dataStatuses: factStatusProperty
      },
      ["query"]
    ),
    async (input) => {
      const loaded = await repository.searchCouncil({
        ...input,
        limit: input.limit ?? 5,
        dataStatuses: statuses(input)
      });
      return {
        data_status: responseStatus(loaded.dataStatuses),
        data_statuses: loaded.dataStatuses,
        result: { matches: loaded.records },
        sources: loaded.sources,
        limitations: [
          "PDF text layer의 읽기 순서와 표 구조는 원문 페이지에서 재확인해야 합니다.",
          ...statusLimitations(loaded.dataStatuses)
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
        tolerancePercent: { type: "number", minimum: 0, maximum: 100, default: 1 },
        dataStatuses: factStatusProperty
      },
      ["metric", "region", "year", "claimedValue"]
    ),
    async (input) => {
      const loaded =
        input.metric === "population"
          ? await repository.findPopulationValue({
              region: input.region,
              year: input.year,
              dataStatuses: statuses(input)
            })
          : await repository.findLocalTaxValue({
              region: input.region,
              year: input.year,
              dataStatuses: statuses(input)
            });
      const row = loaded.records[0];
      if (!row) throw new Error("검증에 필요한 기준 데이터가 없습니다.");
      const actualValue =
        "populationTotal" in row ? row.populationTotal : row.revenueAmountWon;
      const taxRow = "revenueAmountWon" in row ? row : null;
      const officialEvidence = row.dataStatus === "official_observed";
      const difference = input.claimedValue - actualValue;
      const tolerancePercent = input.tolerancePercent ?? 1;
      const differencePercent =
        actualValue === 0
          ? 0
          : Number(((Math.abs(difference) / actualValue) * 100).toFixed(3));
      return {
        data_status: responseStatus(loaded.dataStatuses),
        data_statuses: loaded.dataStatuses,
        result: {
          verdict: officialEvidence
            ? differencePercent <= tolerancePercent
              ? "consistent"
              : "inconsistent"
            : "not_verifiable",
          verification_unavailable_reason: officialEvidence
            ? null
            : "demo_data_not_evidence",
          claimed_value: input.claimedValue,
          actual_value: actualValue,
          difference: officialEvidence ? difference : null,
          difference_percent: officialEvidence ? differencePercent : null,
          tolerance_percent: tolerancePercent,
          source_id: row.sourceId,
          record_data_status: row.dataStatus,
          accounting_basis: taxRow?.accountingBasis ?? null,
          amount_semantics: taxRow?.amountSemantics ?? null,
          source_grain: taxRow?.sourceGrain ?? null
        },
        sources: loaded.sources,
        limitations: [
          ...(!officialEvidence
            ? [
                "demo_sample 값은 주장 지지·반박 근거로 사용하지 않았습니다."
              ]
            : []),
          ...(taxRow ? taxCoverageLimitations([taxRow]) : []),
          ...statusLimitations(loaded.dataStatuses)
        ]
      };
    }
  );

  add(
    "get_source_context",
    "source_id로 출처 메타데이터와 원문 행·페이지·chunk 위치를 조회합니다.",
    sourceContextInputSchema,
    objectSchema(
      {
        sourceIds: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string" }
        }
      },
      ["sourceIds"]
    ),
    async (input) => {
      const loaded = await repository.getSourceContexts(input.sourceIds);
      const matched = new Set(
        loaded.records.flatMap((context) => context.aliases ?? [context.source.sourceId])
      );
      return {
        data_status: responseStatus(loaded.dataStatuses),
        data_statuses: loaded.dataStatuses,
        result: {
          requested: input.sourceIds,
          found: loaded.records,
          missing: input.sourceIds.filter((sourceId) => !matched.has(sourceId))
        },
        sources: loaded.sources,
        limitations: [
          "excerpt는 최대 1,000자로 제한되며 전체 원문은 locator의 파일/페이지에서 확인해야 합니다."
        ]
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
      const usedStatuses = [
        ...new Set(input.verifiedAnalysis.sources.map((source) => source.dataStatus))
      ];
      return {
        data_status: responseStatus(usedStatuses),
        data_statuses: usedStatuses,
        result,
        sources: input.verifiedAnalysis.sources,
        limitations: [
          ...input.verifiedAnalysis.limitations,
          "제출 전 최신 서식과 담당 기관 요구사항을 확인해야 합니다."
        ]
      };
    }
  );

  return { tools: definitions, repository };
}

let generatedAuditSalt: string | undefined;

function auditSalt(): string {
  generatedAuditSalt ??= randomBytes(32).toString("hex");
  return process.env.AUDIT_HASH_SALT ?? generatedAuditSalt;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function redactedMetadata(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { inputType: typeof input };
  }
  const allowedKeys = new Set([
    "age",
    "asOfDate",
    "claimedValue",
    "council",
    "dataStatuses",
    "dateFrom",
    "dateTo",
    "documentType",
    "endYear",
    "limit",
    "metric",
    "query",
    "region",
    "regions",
    "requesterContext",
    "sourceIds",
    "stage",
    "startYear",
    "taxCategory",
    "title",
    "tolerancePercent",
    "verifiedAnalysis",
    "year"
  ]);
  const entries = Object.entries(input as Record<string, unknown>).slice(0, 30);
  const safeEntries = entries.filter(([key]) => allowedKeys.has(key));
  return {
    keys: safeEntries.map(([key]) => key).sort(),
    unknownFieldCount: entries.length - safeEntries.length,
    fields: Object.fromEntries(
      safeEntries.map(([key, value]) => [
        key,
        Array.isArray(value)
          ? { type: "array", length: value.length }
          : typeof value === "string"
            ? { type: "string", length: value.length }
            : { type: typeof value }
      ])
    )
  };
}

function resultCount(response: ToolResponse): number {
  const result = response.result;
  if (!result || typeof result !== "object") return result === undefined ? 0 : 1;
  for (const key of ["matches", "points", "found", "all_regions"]) {
    const value = (result as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value.length;
  }
  return 1;
}

export async function executeTool(
  registry: ToolRegistry,
  name: string,
  input: unknown,
  context: ToolExecutionContext = {}
): Promise<ToolResponse> {
  const startedAt = new Date();
  const auditToolName = registry.tools[name] ? name : "unsupported";
  let response: ToolResponse | undefined;
  let caught: unknown;
  try {
    if (context.signal?.aborted) {
      throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
    }
    const tool = registry.tools[name];
    if (!tool) throw new Error(`지원하지 않는 도구입니다: ${name}`);
    const parsed = tool.parse(input);
    response = await tool.execute(parsed as never);
    return response;
  } catch (error) {
    caught = error;
    throw error;
  } finally {
    const finishedAt = new Date();
    const aborted = context.signal?.aborted === true;
    try {
      await registry.repository.writeAudit({
        toolName: auditToolName.slice(0, 120),
        startedAt,
        finishedAt,
        success: caught === undefined && !aborted,
        dataStatuses: response?.data_statuses ?? [],
        resultCount: response ? resultCount(response) : 0,
        requestHash: createHash("sha256")
          .update(auditSalt())
          .update(name)
          .update(stableJson(input))
          .digest("hex"),
        requestMetadata: redactedMetadata(input),
        correlationId: context.correlationId ?? null,
        errorClass:
          aborted
            ? "AbortError"
            : caught === undefined
              ? null
            : caught instanceof Error
              ? caught.name
              : "UnknownError"
      });
    } catch (auditError) {
      const code =
        typeof auditError === "object" && auditError !== null && "code" in auditError
          ? String((auditError as { code?: unknown }).code)
          : "audit_write_failed";
      console.error(
        JSON.stringify({
          warning: "audit_write_failed",
          toolName: auditToolName.slice(0, 120),
          correlationId: context.correlationId ?? null,
          code
        })
      );
    }
  }
}
