import {
  getDatasetDefinition,
  joinability,
  type EvidenceContract,
  type SourceRef
} from "@gb/domain";
import { executeTool, type ToolExecutionContext, type ToolRegistry } from "./tools.js";

/**
 * One dataset's contribution to a regional evidence pack.
 *
 * `contract` travels with the node rather than being looked up later, so a
 * consumer rendering a single node always has the claim boundary that applies
 * to it.
 */
export interface EvidenceNode {
  datasetId: string;
  title: string;
  tool: string;
  role: "observed_fact" | "narrative_context_only";
  dataStatus: string;
  summary: string;
  itemCount: number;
  sourceIds: string[];
  contract: EvidenceContract;
  detail: unknown;
}

/**
 * A question this pack cannot answer, and what would answer it.
 *
 * The gap list is the reason this tool exists. Any search can return documents;
 * the expensive part of using public data is discovering, after hours of
 * reading, that the number you need was never published. Naming the absence up
 * front is what turns a reading exercise into an actionable one, which is why
 * every gap carries the administrative action that would close it.
 */
export interface EvidenceGap {
  /** What cannot be established from the loaded data. */
  question: string;
  /** Why the pack cannot establish it. */
  reason: string;
  /** The concrete record that would close the gap. */
  wouldBeClosedBy: string;
  /** The body that holds it, used to address a disclosure request. */
  holder: string;
}

export interface RegionalEvidencePack {
  region: string;
  issue: string;
  period: { startYear: number; endYear: number };
  /** Statistical evidence: the only nodes that may support a number. */
  observed: EvidenceNode[];
  /** Narrative evidence: plans, debate and announcements. */
  context: EvidenceNode[];
  /** Declared joins actually available between the observed datasets. */
  links: Array<{
    from: string;
    to: string;
    joinKeys: string[];
    rationale: string;
    caveats: string[];
  }>;
  gaps: EvidenceGap[];
  /** Civic actions the gaps justify, in the order they should be taken. */
  recommendedActions: Array<{
    action: string;
    rationale: string;
    addressedTo: string;
  }>;
  sources: SourceRef[];
  limitations: string[];
  dataStatuses: string[];
}

interface Probe {
  datasetId: string;
  tool: string;
  argumentsFor: (input: PackInput) => Record<string, unknown>;
  /**
   * Whether the probed tool's schema accepts a data-status filter. The schemas
   * are strict, so passing the key to a tool that does not declare it throws.
   */
  acceptsDataStatuses?: boolean;
  /** Reads the tool's own result shape and reports how many records it found. */
  count: (result: unknown) => number;
  summarize: (result: unknown, count: number) => string;
}

export interface PackInput {
  region: string;
  issue: string;
  startYear: number;
  endYear: number;
  /**
   * Mirrors the filter every other tool exposes. Operations run on
   * `official_observed` alone; widening it is an explicit, recorded choice
   * rather than a default the pack makes on the caller's behalf.
   */
  dataStatuses?: readonly string[];
}

function rows(result: unknown, key: string): unknown[] {
  if (typeof result !== "object" || result === null) return [];
  const value = (result as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

/**
 * The datasets probed for every pack.
 *
 * Fixed rather than planned by a model: a pack is a claim about what does and
 * does not exist for a region, so it has to probe the same datasets every time.
 * A model that quietly skipped the tax series would produce a pack whose
 * "no data" conclusion reflected the model's choice rather than the data.
 */
/**
 * Narrative sources are region-tagged at province level, so a county filter
 * removes every row. Matching on the region name in the body text finds the
 * documents that actually discuss the place, and the pack says so in its
 * limitations rather than presenting province-wide material as local.
 */
function narrativeQuery(input: PackInput): string {
  return `${input.region} ${input.issue}`.trim();
}

const PROBES: Probe[] = [
  {
    datasetId: "population_observation",
    tool: "get_population_trend",
    acceptsDataStatuses: true,
    argumentsFor: (input) => ({
      region: input.region,
      startYear: input.startYear,
      endYear: input.endYear
    }),
    count: (result) => rows(result, "points").length,
    summarize: (result, count) => {
      const series = rows(result, "points") as Array<{ year?: number }>;
      if (count === 0) return "해당 기간의 인구 관측이 없습니다.";
      const years = series.map((row) => row.year).filter((year) => year !== undefined);
      return `인구 관측 ${count}개 연도 (${Math.min(...(years as number[]))}~${Math.max(...(years as number[]))})`;
    }
  },
  {
    datasetId: "local_tax_revenue",
    tool: "get_local_tax_revenue_trend",
    acceptsDataStatuses: true,
    argumentsFor: (input) => ({
      region: input.region,
      startYear: input.startYear,
      endYear: input.endYear
    }),
    count: (result) => rows(result, "points").length,
    summarize: (_result, count) =>
      count === 0
        ? "해당 기간의 지방세 세수 관측이 없습니다."
        : `지방세 세수 관측 ${count}개 연도`
  },
  {
    datasetId: "press_release",
    tool: "search_press_releases",
    argumentsFor: (input) => ({ query: narrativeQuery(input), limit: 5 }),
    count: (result) => rows(result, "matches").length,
    summarize: (_result, count) =>
      count === 0
        ? "해당 사안을 다룬 보도자료를 찾지 못했습니다."
        : `관련 보도자료 ${count}건`
  },
  {
    datasetId: "council_record",
    tool: "search_council_records",
    acceptsDataStatuses: true,
    argumentsFor: (input) => ({ query: narrativeQuery(input), limit: 5 }),
    count: (result) => rows(result, "matches").length,
    summarize: (_result, count) =>
      count === 0
        ? "해당 사안을 다룬 회의 기록을 찾지 못했습니다."
        : `관련 회의 기록 ${count}건`
  },
  {
    datasetId: "council_bill",
    tool: "search_member_bills",
    argumentsFor: (input) => ({ query: narrativeQuery(input), limit: 5 }),
    count: (result) => rows(result, "matches").length,
    summarize: (_result, count) =>
      count === 0
        ? "해당 사안으로 발의된 의안을 찾지 못했습니다."
        : `관련 의안 ${count}건`
  },
  {
    datasetId: "document_chunk",
    tool: "search_documents",
    acceptsDataStatuses: true,
    argumentsFor: (input) => ({ query: narrativeQuery(input), limit: 5 }),
    count: (result) => rows(result, "matches").length,
    summarize: (_result, count) =>
      count === 0
        ? "해당 사안을 다룬 공식 문서 본문을 찾지 못했습니다."
        : `관련 공식 문서 ${count}개 페이지`
  }
];

/**
 * Derives the gaps from what the probes found.
 *
 * Written as rules over the probe outcomes rather than as prose, so a pack
 * cannot claim a gap that the data does not show, and cannot stay silent about
 * one that it does.
 */
function deriveGaps(
  input: PackInput,
  observed: EvidenceNode[],
  context: EvidenceNode[],
  attempted: Set<string>
): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  const found = (datasetId: string, nodes: EvidenceNode[]) =>
    nodes.find((node) => node.datasetId === datasetId);

  // 1. Announced but unmeasured. This is the gap that matters most: the province
  //    said it would act, and nothing in the loaded data says whether it did.
  if (context.length > 0) {
    gaps.push({
      question: `${input.issue} 관련 사업이 실제로 집행되었고 어떤 성과를 냈는가?`,
      reason:
        "적재된 자료 중 계획·발표·논의는 있으나 집행 실적과 성과를 담은 관측 데이터셋이 없습니다. 보도자료와 업무계획의 수치는 계획치이므로 성과 근거가 될 수 없습니다.",
      wouldBeClosedBy:
        "사업별 예산 집행 내역과 성과지표 실적치 (결산 자료 또는 사업 성과보고서)",
      holder: "경상북도 및 해당 시군의 사업 소관 부서"
    });
  }

  // 2. A statistical series too short to support a trend. Reporting "population
  //    fell" from a single point is the most common misuse of this data.
  for (const node of observed) {
    if (node.itemCount === 1) {
      gaps.push({
        question: `${input.region}의 ${node.title} 추세를 ${input.startYear}~${input.endYear}년 구간에서 말할 수 있는가?`,
        reason: `해당 구간에 관측이 1개 연도뿐이라 증감을 계산할 수 없습니다.`,
        wouldBeClosedBy: `${input.region}의 누락 연도 ${node.title} 원자료`,
        holder: "통계청 및 경상북도 통계 담당 부서"
      });
    }
  }

  // 3. A statistical dataset that was probed and returned nothing at all.
  for (const datasetId of ["population_observation", "local_tax_revenue"]) {
    if (!attempted.has(datasetId)) continue;
    if (found(datasetId, observed)) continue;
    const definition = getDatasetDefinition(datasetId);
    gaps.push({
      question: `${input.region}의 ${definition?.title ?? datasetId}를 ${input.startYear}~${input.endYear}년 구간에서 확인할 수 있는가?`,
      reason: "해당 지역·기간에 적재된 관측이 없습니다.",
      wouldBeClosedBy: `${input.region}의 해당 기간 ${definition?.title ?? datasetId} 원자료`,
      holder: "경상북도 및 해당 시군의 통계 담당 부서"
    });
  }

  // 4. No statistical footing at all. A pack made only of announcements can
  //    describe intent and nothing else, and must say so.
  if (observed.length === 0) {
    gaps.push({
      question: `${input.issue}에 대해 수치로 뒷받침되는 결론을 낼 수 있는가?`,
      reason:
        "관측 통계 근거가 하나도 확보되지 않아, 이 묶음은 계획과 논의의 존재만 보여 줍니다.",
      wouldBeClosedBy: "해당 사안을 측정한 공식 통계 시계열",
      holder: "통계청 및 경상북도 통계 담당 부서"
    });
  }

  return gaps;
}

function recommendActions(
  input: PackInput,
  gaps: EvidenceGap[],
  context: EvidenceNode[]
): RegionalEvidencePack["recommendedActions"] {
  const actions: RegionalEvidencePack["recommendedActions"] = [];
  if (gaps.length === 0) return actions;

  // Ordered deliberately: ask for the record first, propose spending second.
  // A participatory-budget proposal written before the execution record is in
  // hand is the kind of unevidenced demand this project exists to avoid.
  const holders = [...new Set(gaps.map((gap) => gap.holder))];
  actions.push({
    action: "정보공개청구",
    rationale: `근거 공백 ${gaps.length}건을 메우려면 공개되지 않은 원자료가 필요합니다: ${gaps
      .map((gap) => gap.wouldBeClosedBy)
      .join("; ")}`,
    addressedTo: holders.join(", ")
  });
  if (context.length > 0) {
    actions.push({
      action: "주민참여예산 제안",
      rationale:
        "계획·논의는 확인되었으므로, 공개된 집행 근거를 확보한 뒤에 제안 근거로 사용할 수 있습니다. 청구 결과 확인 전에는 제안서에 성과 주장을 담지 않아야 합니다.",
      addressedTo: `${input.region} 주민참여예산 담당 부서`
    });
  }
  return actions;
}

/**
 * Compiles one region's evidence chain for one issue.
 *
 * Returns statistics, narrative context, the joins available between them, the
 * questions the loaded data cannot answer, and the civic actions those gaps
 * justify — as one verifiable object rather than as separate searches a person
 * has to reconcile.
 */
export async function buildRegionalEvidencePack(
  registry: ToolRegistry,
  input: PackInput,
  context: ToolExecutionContext = {}
): Promise<RegionalEvidencePack> {
  const observedNodes: EvidenceNode[] = [];
  const contextNodes: EvidenceNode[] = [];
  const sources: SourceRef[] = [];
  const limitations = new Set<string>();
  const dataStatuses = new Set<string>();
  const attempted = new Set<string>();

  for (const probe of PROBES) {
    const definition = getDatasetDefinition(probe.datasetId);
    if (!definition) continue;
    if (!registry.tools[probe.tool]) continue;
    attempted.add(probe.datasetId);
    let response;
    try {
      response = await executeTool(
        registry,
        probe.tool,
        {
          ...probe.argumentsFor(input),
          ...(probe.acceptsDataStatuses && input.dataStatuses
            ? { dataStatuses: input.dataStatuses }
            : {})
        },
        context
      );
    } catch (caught) {
      // A refusal is information about the data, not a failure of the pack.
      limitations.add(
        `${definition.title} 조회가 거부되었습니다: ${
          caught instanceof Error ? caught.message : String(caught)
        }`
      );
      continue;
    }
    const count = probe.count(response.result);
    if (count === 0 || response.sources.length === 0) {
      limitations.add(`${definition.title}: ${probe.summarize(response.result, 0)}`);
      continue;
    }
    const node: EvidenceNode = {
      datasetId: probe.datasetId,
      title: definition.title,
      tool: probe.tool,
      role: definition.evidenceRole,
      dataStatus: response.data_status,
      summary: probe.summarize(response.result, count),
      itemCount: count,
      sourceIds: response.sources.map((source) => source.sourceId),
      contract: definition.evidenceContract,
      detail: response.result
    };
    if (definition.evidenceRole === "observed_fact") observedNodes.push(node);
    else contextNodes.push(node);
    sources.push(...response.sources);
    dataStatuses.add(response.data_status);
    for (const rule of definition.usageRules) limitations.add(rule);
    for (const limitation of response.limitations) limitations.add(limitation);
  }

  const links: RegionalEvidencePack["links"] = [];
  for (let left = 0; left < observedNodes.length; left += 1) {
    for (let right = left + 1; right < observedNodes.length; right += 1) {
      const relationship = joinability(
        observedNodes[left]!.datasetId,
        observedNodes[right]!.datasetId
      );
      if (!relationship) continue;
      links.push({
        from: relationship.from,
        to: relationship.to,
        joinKeys: relationship.joinKeys,
        rationale: relationship.rationale,
        caveats: relationship.caveats
      });
      for (const caveat of relationship.caveats) limitations.add(caveat);
    }
  }

  const gaps = deriveGaps(input, observedNodes, contextNodes, attempted);
  if (contextNodes.length > 0) {
    limitations.add(
      `서술 자료는 본문에 '${input.region}'이 언급된 문서를 찾은 결과이며, 구조화된 지역 태그로 걸러낸 것이 아닙니다. 도 전역 사안을 다룬 문서가 포함될 수 있습니다.`
    );
    limitations.add(
      "보도자료·회의록·의안·업무계획은 계획과 논의의 기록이며, 본문에 실린 수치를 관측 통계로 인용해서는 안 됩니다."
    );
  }

  return {
    region: input.region,
    issue: input.issue,
    period: { startYear: input.startYear, endYear: input.endYear },
    observed: observedNodes,
    context: contextNodes,
    links,
    gaps,
    recommendedActions: recommendActions(input, gaps, contextNodes),
    sources: [
      ...new Map(sources.map((source) => [source.sourceId, source])).values()
    ],
    limitations: [...limitations],
    dataStatuses: [...dataStatuses]
  };
}
