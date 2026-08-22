import type { AgentPlan, AgentPlanStep, Planner, PlannerInput } from "./agent.js";
import { extractEntities, GYEONGBUK_REGIONS, normalizeRegionName } from "./entities.js";
import type { ExtractedEntities } from "./entities.js";
export type { ExtractedEntities };

/**
 * Deterministic planner.
 *
 * Always available and fully testable, so the agent has a working route with no
 * API key and the benchmark can attribute failures to routing rather than to a
 * model's mood. It plans from the same catalog output an LLM planner sees.
 */
/**
 * Coverage a given tool will actually see.
 *
 * A tool that filters by region sees only that region's rows, so it must be
 * judged against the region-scoped range. A tool that does not take a region —
 * press-release and bill search — sees everything, and judging it against an
 * empty region scope would wrongly discard province-level material from a
 * county question.
 */
export function effectiveYearRange(
  candidate: PlannerInput["candidates"][number],
  regionFiltered: boolean
): { range: { start: number; end: number } | null; scopeLabel: string } {
  const regionCoverage = candidate.coverage.regionCoverage;
  if (regionFiltered && regionCoverage) {
    return {
      range: regionCoverage.yearRange,
      scopeLabel: `${regionCoverage.region} ${candidate.title}`
    };
  }
  return { range: candidate.coverage.yearRange, scopeLabel: candidate.title };
}

/**
 * Explains why the requested year window cannot be served, or null if it can.
 *
 * Only fires when the question named years explicitly; an unstated window is
 * filled from coverage further down and is never a mismatch.
 */
export function yearWindowGap(
  entities: ExtractedEntities,
  candidate: PlannerInput["candidates"][number],
  regionFiltered: boolean
): string | null {
  if (entities.startYear === null || entities.endYear === null) return null;
  const { range, scopeLabel } = effectiveYearRange(candidate, regionFiltered);
  if (!range) {
    if (!regionFiltered || !candidate.coverage.regionCoverage) return null;
    return `${scopeLabel}에 해당하는 행이 없어 요청하신 ${entities.startYear}~${entities.endYear}년 구간은 답할 수 없습니다.`;
  }
  if (entities.startYear <= range.end && entities.endYear >= range.start) {
    return null;
  }
  return `${scopeLabel}은(는) ${range.start}~${range.end}년만 적재되어 있어 요청하신 ${entities.startYear}~${entities.endYear}년 구간은 답할 수 없습니다.`;
}

export class HeuristicPlanner implements Planner {
  readonly name = "heuristic";

  async plan(input: PlannerInput): Promise<AgentPlan> {
    const entities = extractEntities(input.question);
    const steps: AgentPlanStep[] = [];
    const coverageGaps: string[] = [];

    for (const candidate of input.candidates) {
      if (!candidate.coverage.available) continue;
      for (const binding of candidate.tools) {
        const args = this.argumentsFor(binding.tool, entities, input.question, candidate);
        if (!args) continue;
        // Refuse a window the data cannot cover instead of calling the tool and
        // reporting a bare "no data". Judged per tool, because only region-
        // filtered tools are constrained by the region's own coverage.
        const gap = yearWindowGap(
          entities,
          candidate,
          args.region !== undefined && args.region !== null
        );
        if (gap) {
          coverageGaps.push(gap);
          continue;
        }
        const missing = binding.requiredArguments.filter(
          (name) => args[name] === undefined || args[name] === null
        );
        if (missing.length > 0) continue;
        steps.push({
          datasetId: candidate.datasetId,
          tool: binding.tool,
          arguments: args,
          reason: `질문에서 ${candidate.matchedTerms
            .slice(0, 3)
            .join(", ")} 용어가 이 데이터셋과 일치했습니다.`
        });
        break;
      }
    }

    if (steps.length === 0) {
      return {
        steps: [],
        unanswerable:
          coverageGaps.length > 0
            ? coverageGaps.join(" ")
            : this.explainGap(entities, input)
      };
    }
    return { steps, unanswerable: null };
  }

  private argumentsFor(
    tool: string,
    entities: ExtractedEntities,
    question: string,
    candidate: PlannerInput["candidates"][number]
  ): Record<string, unknown> | null {
    // Fall back to the dataset's own loaded range when the question implies a
    // trend but names no years. Guessing a fixed window instead would silently
    // answer about a period the deployment may not even cover.
    const coverage = candidate.coverage.yearRange;
    const startYear = entities.startYear ?? coverage?.start ?? null;
    const endYear = entities.endYear ?? coverage?.end ?? null;

    // Ask for exactly the statuses the catalog says this deployment holds.
    // The tools default to official_observed only, so on a demo-only
    // deployment an unqualified call returns nothing and the agent would
    // report "no data" when data exists — just not official data. Requesting
    // it explicitly keeps the demo_sample label (and its limitation) attached
    // to the answer rather than hiding the distinction.
    const dataStatuses = candidate.coverage.dataStatuses.filter(
      (status): status is "official_observed" | "demo_sample" =>
        status === "official_observed" || status === "demo_sample"
    );
    const withStatuses = (args: Record<string, unknown>) =>
      dataStatuses.length > 0 ? { ...args, dataStatuses } : args;

    switch (tool) {
      case "get_population_trend":
      case "get_local_tax_revenue_trend":
        return withStatuses({
          region: entities.region,
          startYear,
          endYear
        });
      case "search_policies":
        return withStatuses({
          region: entities.region,
          query: question.slice(0, 200),
          ...(entities.age !== null ? { age: entities.age } : {})
        });
      case "search_council_records":
        return withStatuses({ query: question.slice(0, 200), limit: 5 });
      case "search_press_releases":
        return { query: question.slice(0, 200), limit: 5 };
      case "search_member_bills":
        return { query: question.slice(0, 200), limit: 5 };
      default:
        // get_source_context and draft_public_document need inputs that only
        // exist after another step has run, so they are never planned upfront.
        return null;
    }
  }

  private explainGap(
    entities: ExtractedEntities,
    input: PlannerInput
  ): string {
    const needsRegion = input.candidates.some((candidate) =>
      candidate.tools.some((binding) =>
        binding.requiredArguments.includes("region")
      )
    );
    if (needsRegion && !entities.region) {
      return "질문에서 경상북도 내 시군을 찾지 못해 지역이 필요한 도구를 호출할 수 없습니다. 시군 이름을 포함해 다시 질문하세요.";
    }
    const unavailable = input.candidates.filter(
      (candidate) => !candidate.coverage.available
    );
    if (unavailable.length === input.candidates.length) {
      return "관련 데이터셋을 찾았지만 현재 배포에 적재된 행이 없습니다.";
    }
    return "후보 데이터셋을 찾았지만 도구 호출에 필요한 인자를 질문에서 확보하지 못했습니다.";
  }
}

export { extractEntities, GYEONGBUK_REGIONS, normalizeRegionName };
