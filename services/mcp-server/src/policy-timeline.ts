import { getDatasetDefinition, type SourceRef } from "@gb/domain";
import { executeTool, type ToolExecutionContext, type ToolRegistry } from "./tools.js";

/**
 * One dated record in an issue's administrative trail.
 *
 * `stage` is derived from which dataset the record came from, never from its
 * wording. A press release saying "완료했다" is still an announcement, and
 * classifying it by its own claim would let the province grade its own work.
 */
export interface PolicyTimelineEntry {
  date: string;
  stage: "plan" | "announcement" | "deliberation" | "legislation";
  datasetId: string;
  title: string;
  excerpt: string;
  sourceId: string;
  locator: string;
  url: string | null;
  dataStatus: string;
  /** What this entry establishes, stated so a reader cannot over-read it. */
  establishes: string;
}

export interface PolicyTimeline {
  region: string;
  issue: string;
  window: { from: string | null; to: string | null };
  entries: PolicyTimelineEntry[];
  /** Counts per stage, so an absent stage is visible without reading the list. */
  stageCounts: Record<PolicyTimelineEntry["stage"], number>;
  /** Stages with no record found, named explicitly rather than left blank. */
  missingStages: PolicyTimelineEntry["stage"][];
  /**
   * Always populated. A timeline shows that something was said and when; it
   * cannot show whether the thing was done, and this field says so in the
   * response rather than leaving the reader to infer it from a caveat list.
   */
  outcomeAssessment: null;
  outcomeAssessmentUnavailableReason: string;
  sources: SourceRef[];
  limitations: string[];
  dataStatuses: string[];
}

export interface TimelineInput {
  region: string;
  issue: string;
  dateFrom?: string;
  dateTo?: string;
  limitPerStage?: number;
  dataStatuses?: readonly string[];
}

const STAGE_LABELS: Record<PolicyTimelineEntry["stage"], string> = {
  plan: "계획 문서에 해당 내용이 기재되었다는 사실",
  announcement: "행정이 해당 내용을 대외에 발표했다는 사실",
  deliberation: "의회에서 해당 내용이 논의되었다는 사실",
  legislation: "해당 내용으로 의안이 발의되었다는 사실"
};

interface StageProbe {
  stage: PolicyTimelineEntry["stage"];
  datasetId: string;
  tool: string;
  acceptsDataStatuses?: boolean;
  argumentsFor: (input: TimelineInput, limit: number) => Record<string, unknown>;
  extract: (result: unknown) => PolicyTimelineEntry[];
}

function records(result: unknown, key: string): Array<Record<string, unknown>> {
  if (typeof result !== "object" || result === null) return [];
  const value = (result as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function meta(record: Record<string, unknown>): Record<string, unknown> {
  const value = record.metadata;
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function excerpt(value: unknown): string {
  const body = text(value).replace(/\s+/g, " ").trim();
  return body.length > 200 ? `${body.slice(0, 200)}…` : body;
}

const PROBES: StageProbe[] = [
  {
    stage: "plan",
    datasetId: "document_chunk",
    tool: "search_documents",
    acceptsDataStatuses: true,
    argumentsFor: (input, limit) => ({
      query: `${input.region} ${input.issue}`.trim(),
      ...(input.dateFrom ? { dateFrom: input.dateFrom } : {}),
      ...(input.dateTo ? { dateTo: input.dateTo } : {}),
      limit
    }),
    extract: (result) =>
      records(result, "matches").map((record) => {
        const metadata = meta(record);
        return {
          date: text(metadata.meetingDate),
          stage: "plan" as const,
          datasetId: "document_chunk",
          title: text(record.title, "(제목 없음)"),
          excerpt: excerpt(record.text),
          sourceId: text(metadata.sourceId),
          locator: text(metadata.locator),
          url: null,
          dataStatus: text(metadata.dataStatus),
          establishes: STAGE_LABELS.plan
        };
      })
  },
  {
    stage: "announcement",
    datasetId: "press_release",
    tool: "search_press_releases",
    argumentsFor: (input, limit) => ({
      query: `${input.region} ${input.issue}`.trim(),
      ...(input.dateFrom ? { dateFrom: input.dateFrom } : {}),
      ...(input.dateTo ? { dateTo: input.dateTo } : {}),
      limit
    }),
    extract: (result) =>
      records(result, "matches").map((record) => {
        const metadata = meta(record);
        return {
          date: text(metadata.publishedDate),
          stage: "announcement" as const,
          datasetId: "press_release",
          title: text(record.title, "(제목 없음)"),
          excerpt: excerpt(record.text),
          sourceId: text(metadata.sourceId),
          locator: text(metadata.locator),
          url: text(metadata.detailUrl) || null,
          dataStatus: text(metadata.dataStatus),
          establishes: STAGE_LABELS.announcement
        };
      })
  },
  {
    stage: "deliberation",
    datasetId: "council_record",
    tool: "search_council_records",
    acceptsDataStatuses: true,
    argumentsFor: (input, limit) => ({
      query: `${input.region} ${input.issue}`.trim(),
      ...(input.dateFrom ? { dateFrom: input.dateFrom } : {}),
      ...(input.dateTo ? { dateTo: input.dateTo } : {}),
      limit
    }),
    extract: (result) =>
      records(result, "matches").map((record) => {
        const metadata = meta(record);
        return {
          date: text(metadata.meetingDate),
          stage: "deliberation" as const,
          datasetId: "council_record",
          title: text(record.title, "(제목 없음)"),
          excerpt: excerpt(record.text),
          sourceId: text(metadata.sourceId),
          locator: text(metadata.locator),
          url: null,
          dataStatus: text(metadata.dataStatus),
          establishes: STAGE_LABELS.deliberation
        };
      })
  },
  {
    stage: "legislation",
    datasetId: "council_bill",
    tool: "search_member_bills",
    argumentsFor: (input, limit) => ({
      query: `${input.region} ${input.issue}`.trim(),
      ...(input.dateFrom ? { dateFrom: input.dateFrom } : {}),
      ...(input.dateTo ? { dateTo: input.dateTo } : {}),
      limit
    }),
    extract: (result) =>
      records(result, "matches").map((record) => {
        const metadata = meta(record);
        return {
          date: text(metadata.proposedDate),
          stage: "legislation" as const,
          datasetId: "council_bill",
          title: text(record.title, "(제목 없음)"),
          excerpt: excerpt(record.text),
          sourceId: text(metadata.sourceId),
          locator: text(metadata.locator),
          url: text(metadata.detailUrl) || null,
          dataStatus: text(metadata.dataStatus),
          establishes: STAGE_LABELS.legislation
        };
      })
  }
];

/**
 * Orders an issue's administrative record without judging it.
 *
 * The value of a timeline here is negative as much as positive: seeing that a
 * commitment was announced in 2022, never appeared in a council record, and
 * never became a bill is a finding, and it is only visible when the stages that
 * produced nothing are named. So `missingStages` is part of the result rather
 * than an empty section a reader has to notice.
 */
export async function tracePolicyResponse(
  registry: ToolRegistry,
  input: TimelineInput,
  context: ToolExecutionContext = {}
): Promise<PolicyTimeline> {
  const limit = input.limitPerStage ?? 5;
  const entries: PolicyTimelineEntry[] = [];
  const sources: SourceRef[] = [];
  const limitations = new Set<string>();
  const dataStatuses = new Set<string>();
  const stageCounts: Record<PolicyTimelineEntry["stage"], number> = {
    plan: 0,
    announcement: 0,
    deliberation: 0,
    legislation: 0
  };

  for (const probe of PROBES) {
    if (!registry.tools[probe.tool]) continue;
    const definition = getDatasetDefinition(probe.datasetId);
    let response;
    try {
      response = await executeTool(
        registry,
        probe.tool,
        {
          ...probe.argumentsFor(input, limit),
          ...(probe.acceptsDataStatuses && input.dataStatuses
            ? { dataStatuses: input.dataStatuses }
            : {})
        },
        context
      );
    } catch (caught) {
      limitations.add(
        `${definition?.title ?? probe.datasetId} 조회가 거부되었습니다: ${
          caught instanceof Error ? caught.message : String(caught)
        }`
      );
      continue;
    }
    const found = probe.extract(response.result).filter((entry) => entry.date);
    if (found.length === 0) continue;
    entries.push(...found);
    stageCounts[probe.stage] += found.length;
    sources.push(...response.sources);
    for (const status of response.data_statuses) dataStatuses.add(status);
    for (const limitation of response.limitations) limitations.add(limitation);
  }

  entries.sort(
    (left, right) => left.date.localeCompare(right.date) || left.stage.localeCompare(right.stage)
  );
  const missingStages = (
    Object.keys(stageCounts) as PolicyTimelineEntry["stage"][]
  ).filter((stage) => stageCounts[stage] === 0);

  limitations.add(
    "이 연대기는 무엇이 언제 기록되었는지만 보여 줍니다. 계획·발표·논의·발의는 모두 의사 표명이며, 사업이 실제로 집행되었는지나 성과를 냈는지는 이 자료로 판단할 수 없습니다."
  );
  limitations.add(
    "단계 구분은 자료의 출처 데이터셋으로 정해집니다. 보도자료가 '완료'라고 적더라도 발표 단계로 분류되며, 그 문장은 완료의 근거가 아닙니다."
  );
  limitations.add(
    `검색은 본문에 '${input.region}'과 주제어가 함께 나타나는 기록을 찾습니다. 표현이 다른 기록은 누락될 수 있으므로, 기록이 없다는 것이 그 단계가 없었다는 증명은 아닙니다.`
  );
  if (missingStages.length > 0) {
    limitations.add(
      `기록을 찾지 못한 단계: ${missingStages
        .map((stage) => STAGE_LABELS[stage])
        .join(", ")}`
    );
  }

  return {
    region: input.region,
    issue: input.issue,
    window: { from: input.dateFrom ?? null, to: input.dateTo ?? null },
    entries,
    stageCounts,
    missingStages,
    outcomeAssessment: null,
    outcomeAssessmentUnavailableReason:
      "적재된 자료는 계획과 발표와 논의의 기록일 뿐, 집행 실적과 성과지표를 담고 있지 않습니다. 성과 판정에는 결산 자료 또는 사업 성과보고서가 필요합니다.",
    sources: [
      ...new Map(sources.map((source) => [source.sourceId, source])).values()
    ],
    limitations: [...limitations],
    dataStatuses: [...dataStatuses]
  };
}
