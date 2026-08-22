import { normalizeRegionName } from "@gb/domain";
import type { AgentPlan, AgentPlanStep, Planner, PlannerInput } from "./agent.js";

/** Region names the extractor will recognise in free text. */
const GYEONGBUK_REGIONS = [
  "포항시",
  "경주시",
  "김천시",
  "안동시",
  "구미시",
  "영주시",
  "영천시",
  "상주시",
  "문경시",
  "경산시",
  "의성군",
  "청송군",
  "영양군",
  "영덕군",
  "청도군",
  "고령군",
  "성주군",
  "칠곡군",
  "예천군",
  "봉화군",
  "울진군",
  "울릉군",
  "군위군"
] as const;

export interface ExtractedEntities {
  region: string | null;
  startYear: number | null;
  endYear: number | null;
  age: number | null;
}

/**
 * Pulls the arguments tools need out of a natural-language question.
 *
 * Matching accepts the bare stem ("상주") as well as the full name ("상주시")
 * because people rarely type the administrative suffix.
 */
export function extractEntities(question: string): ExtractedEntities {
  const text = question.normalize("NFC");

  let region: string | null = null;
  for (const candidate of GYEONGBUK_REGIONS) {
    const stem = candidate.slice(0, -1);
    if (text.includes(candidate) || text.includes(stem)) {
      region = candidate;
      break;
    }
  }

  const years = [...text.matchAll(/\b(19\d{2}|20\d{2})\s*년?/gu)]
    .map((match) => Number(match[1]))
    .filter((year) => year >= 1990 && year <= 2100);
  const uniqueYears = [...new Set(years)].sort((left, right) => left - right);

  const ageMatch = text.match(/(\d{1,3})\s*(?:세|살)/u);
  const age = ageMatch ? Number(ageMatch[1]) : null;

  return {
    region,
    startYear: uniqueYears[0] ?? null,
    endYear: uniqueYears.at(-1) ?? uniqueYears[0] ?? null,
    age: age !== null && age >= 0 && age <= 120 ? age : null
  };
}

/**
 * Deterministic planner.
 *
 * Always available and fully testable, so the agent has a working route with no
 * API key and the benchmark can attribute failures to routing rather than to a
 * model's mood. It plans from the same catalog output an LLM planner sees.
 */
export class HeuristicPlanner implements Planner {
  readonly name = "heuristic";

  async plan(input: PlannerInput): Promise<AgentPlan> {
    const entities = extractEntities(input.question);
    const steps: AgentPlanStep[] = [];

    for (const candidate of input.candidates) {
      if (!candidate.coverage.available) continue;
      for (const binding of candidate.tools) {
        const args = this.argumentsFor(binding.tool, entities, input.question, candidate);
        if (!args) continue;
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
        unanswerable: this.explainGap(entities, input)
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

export { GYEONGBUK_REGIONS, normalizeRegionName };
