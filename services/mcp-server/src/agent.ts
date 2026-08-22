import { getDatasetDefinition, joinability, type SourceRef } from "@gb/domain";
import { searchDatasets, type DatasetSearchHit } from "./catalog-tools.js";
import { extractEntities } from "./entities.js";
import { yearWindowGap } from "./planner.js";
import { executeTool, type ToolExecutionContext, type ToolRegistry } from "./tools.js";

/** One tool call the planner wants to make, and why. */
export interface AgentPlanStep {
  datasetId: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** Planner's justification, surfaced so the route can be audited. */
  reason: string;
}

export interface AgentPlan {
  steps: AgentPlanStep[];
  /** Set when the planner concluded the question cannot be answered from the catalog. */
  unanswerable: string | null;
}

export interface PlannerInput {
  question: string;
  candidates: DatasetSearchHit[];
}

export interface Planner {
  readonly name: string;
  plan(input: PlannerInput): Promise<AgentPlan>;
}

export interface AgentEvidence {
  statement: string;
  datasetId: string;
  tool: string;
  dataStatus: string;
  sourceIds: string[];
  detail?: unknown;
}

export interface AgentAnswer {
  question: string;
  planner: string;
  /** Datasets the catalog offered, in rank order, before planning. */
  consideredDatasets: Array<{
    datasetId: string;
    title: string;
    matchedTerms: string[];
    available: boolean;
  }>;
  plan: AgentPlanStep[];
  answered: boolean;
  conclusion: string;
  evidence: AgentEvidence[];
  /** Declared join used to combine two datasets, with the caveats that apply. */
  joins: Array<{
    from: string;
    to: string;
    joinKeys: string[];
    rationale: string;
    caveats: string[];
  }>;
  sources: SourceRef[];
  limitations: string[];
  /** Steps the planner asked for that were refused, and why. */
  rejectedSteps: Array<{ step: AgentPlanStep; reason: string }>;
  /**
   * Datasets the catalog offered for this question that hold no usable rows.
   *
   * Reported even when the question was answered from another dataset: a user
   * asking for policy announcements deserves to know the announcements table is
   * empty and that press releases are context, not eligibility.
   */
  unavailableDatasets: Array<{ datasetId: string; title: string; note: string | null }>;
}

/**
 * Rejects a planner step that the catalog does not sanction.
 *
 * This is the safety boundary of the whole agent: a planner (especially an LLM
 * one) may hallucinate a tool name, attach a tool to the wrong dataset, or omit
 * a required argument. Execution only ever happens for steps that survive this
 * check, so the blast radius of a bad plan is a refusal, never a fabricated
 * answer.
 */
export function validateStep(
  step: AgentPlanStep,
  candidates: DatasetSearchHit[],
  registry: ToolRegistry
): string | null {
  const candidate = candidates.find(
    (hit) => hit.datasetId === step.datasetId
  );
  if (!candidate) {
    return `${step.datasetId}은(는) 이 질문의 후보 데이터셋이 아닙니다.`;
  }
  const binding = candidate.tools.find((entry) => entry.tool === step.tool);
  if (!binding) {
    return `${step.tool}은(는) ${step.datasetId}에 연결된 도구가 아닙니다.`;
  }
  if (!Object.hasOwn(registry.tools, step.tool)) {
    return `${step.tool}은(는) 이 서버에 등록된 도구가 아닙니다.`;
  }
  if (!candidate.coverage.available) {
    return `${step.datasetId}에 적재된 행이 없어 호출해도 결과가 비어 있습니다.`;
  }
  const missing = binding.requiredArguments.filter((name) =>
    isBlank(step.arguments[name])
  );
  if (missing.length > 0) {
    return `${step.tool} 호출에 필요한 인자가 없습니다: ${missing.join(", ")}`;
  }
  // Validate with the tool's own schema, not a parallel set of rules. A planner
  // can satisfy every declared requirement and still produce a call the tool
  // refuses — an empty query string is present but invalid — and catching that
  // here keeps it a rejected plan step rather than a runtime failure.
  try {
    registry.tools[step.tool]!.parse(step.arguments);
  } catch (caught) {
    return `${step.tool} 인자가 도구 스키마를 통과하지 못했습니다: ${
      caught instanceof Error ? caught.message.slice(0, 200) : String(caught)
    }`;
  }
  return null;
}

/** Treats an empty or whitespace-only string as a missing argument. */
function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value.trim().length === 0;
}

/**
 * Runs one question end to end: discover datasets, plan, validate, execute,
 * then compose an answer whose every statement carries its source ids.
 */
export async function runAgent(
  registry: ToolRegistry,
  question: string,
  planner: Planner,
  context: ToolExecutionContext = {}
): Promise<AgentAnswer> {
  // Resolve the region before searching so every candidate reports coverage for
  // the region actually asked about. Union coverage would tell the planner that
  // population spans 2006-2026 when the county in question only has 2025-2026,
  // and the resulting request would come back empty.
  const entities = extractEntities(question);
  const found = await searchDatasets(registry.repository, {
    query: question,
    limit: 5,
    ...(entities.region ? { region: entities.region } : {})
  });
  const consideredDatasets = found.hits.map((hit) => ({
    datasetId: hit.datasetId,
    title: hit.title,
    matchedTerms: hit.matchedTerms,
    available: hit.coverage.available
  }));

  const unavailableDatasets = found.hits
    .filter((hit) => !hit.coverage.available)
    .map((hit) => ({
      datasetId: hit.datasetId,
      title: hit.title,
      note: hit.coverage.note
    }));

  // Computed here rather than trusted from the planner: the model is asked to
  // state the real coverage when it declines, but a fact the system already
  // knows must not depend on the model choosing to repeat it.
  const coverageGaps = found.hits
    .map((hit) => yearWindowGap(entities, hit, hit.coverage.regionCoverage !== null))
    .filter((gap): gap is string => gap !== null);

  const base = {
    question,
    planner: planner.name,
    consideredDatasets,
    unavailableDatasets,
    joins: [] as AgentAnswer["joins"],
    rejectedSteps: [] as AgentAnswer["rejectedSteps"]
  };

  if (found.hits.length === 0) {
    return {
      ...base,
      plan: [],
      answered: false,
      conclusion:
        "이 질문에 답할 수 있는 데이터셋을 카탈로그에서 찾지 못했습니다.",
      evidence: [],
      sources: [],
      limitations: found.notes
    };
  }

  const plan = await planner.plan({ question, candidates: found.hits });

  if (plan.unanswerable) {
    return {
      ...base,
      plan: plan.steps,
      answered: false,
      conclusion: plan.unanswerable,
      evidence: [],
      sources: [],
      limitations: [...found.notes, ...coverageGaps]
    };
  }

  const rejectedSteps: AgentAnswer["rejectedSteps"] = [];
  const accepted: AgentPlanStep[] = [];
  for (const step of plan.steps) {
    const reason = validateStep(step, found.hits, registry);
    if (reason) rejectedSteps.push({ step, reason });
    else accepted.push(step);
  }

  const evidence: AgentEvidence[] = [];
  const sources: SourceRef[] = [];
  const limitations = new Set<string>([...found.notes, ...coverageGaps]);
  const executedDatasets: string[] = [];

  for (const step of accepted) {
    try {
      const response = await executeTool(
        registry,
        step.tool,
        step.arguments,
        context
      );
      const dataset = getDatasetDefinition(step.datasetId);
      // A tool can succeed and still return nothing that supports a claim: a
      // filter that matches no row yields `empty` with no sources. Counting
      // that as evidence would make the agent answer "collected evidence from
      // X" while citing nobody, which is the exact failure this system exists
      // to prevent. Record it as a miss instead.
      if (response.data_status === "empty" || response.sources.length === 0) {
        rejectedSteps.push({
          step,
          reason: `${step.tool} 호출은 성공했지만 조건에 맞는 데이터가 없어 근거로 쓰지 않았습니다.`
        });
        limitations.add(
          `${dataset?.title ?? step.datasetId}에서 조건에 맞는 기록을 찾지 못했습니다.`
        );
        continue;
      }
      executedDatasets.push(step.datasetId);
      for (const rule of dataset?.usageRules ?? []) limitations.add(rule);
      for (const limitation of response.limitations) limitations.add(limitation);
      sources.push(...response.sources);
      evidence.push({
        statement: `${dataset?.title ?? step.datasetId}: ${step.reason}`,
        datasetId: step.datasetId,
        tool: step.tool,
        dataStatus: response.data_status,
        sourceIds: response.sources.map((source) => source.sourceId),
        detail: response.result
      });
    } catch (caught) {
      // A tool that refuses (no data for the region/period, incomparable
      // series) is a legitimate outcome, not a crash. Record it so the answer
      // can say what was attempted rather than silently narrowing scope.
      rejectedSteps.push({
        step,
        reason: `도구 실행이 거부되었습니다: ${
          caught instanceof Error ? caught.message : String(caught)
        }`
      });
    }
  }

  const joins: AgentAnswer["joins"] = [];
  const uniqueExecuted = [...new Set(executedDatasets)];
  for (let left = 0; left < uniqueExecuted.length; left += 1) {
    for (let right = left + 1; right < uniqueExecuted.length; right += 1) {
      const relationship = joinability(
        uniqueExecuted[left]!,
        uniqueExecuted[right]!
      );
      if (!relationship) {
        // Two datasets were read but the catalog declares no way to combine
        // them. Saying so is more honest than implying a relationship.
        limitations.add(
          `${uniqueExecuted[left]}과(와) ${uniqueExecuted[right]} 사이에는 선언된 조인 관계가 없어 각각 따로 보고합니다.`
        );
        continue;
      }
      joins.push({
        from: relationship.from,
        to: relationship.to,
        joinKeys: relationship.joinKeys,
        rationale: relationship.rationale,
        caveats: relationship.caveats
      });
      for (const caveat of relationship.caveats) limitations.add(caveat);
    }
  }

  for (const entry of unavailableDatasets) {
    limitations.add(
      `${entry.title}은(는) 이 질문의 후보였지만 적재된 데이터가 없어 근거로 사용하지 않았습니다${
        entry.note ? ` (${entry.note})` : ""
      }.`
    );
  }

  const narrativeOnly = evidence.filter(
    (item) =>
      getDatasetDefinition(item.datasetId)?.evidenceRole ===
      "narrative_context_only"
  );
  if (narrativeOnly.length > 0) {
    limitations.add(
      "보도자료·회의록·의안은 배경 맥락이며 수치 주장의 근거로 인용하지 않았습니다."
    );
  }

  const answered = evidence.length > 0;
  return {
    ...base,
    plan: plan.steps,
    answered,
    conclusion: answered
      ? `${uniqueExecuted
          .map((datasetId) => getDatasetDefinition(datasetId)?.title ?? datasetId)
          .join(", ")}에서 근거를 수집했습니다.`
      : coverageGaps.length > 0
        ? coverageGaps.join(" ")
        : "계획한 도구 호출이 모두 거부되어 근거를 수집하지 못했습니다.",
    evidence,
    joins,
    sources: [
      ...new Map(sources.map((source) => [source.sourceId, source])).values()
    ],
    limitations: [...limitations],
    rejectedSteps
  };
}
