import type { SourceRef } from "@gb/domain";
import {
  executeTool,
  type ResponseDataStatus,
  type ToolExecutionContext,
  type ToolRegistry
} from "./tools.js";

export const representativeQuestions = [
  {
    id: "population-tax",
    question: "2022년부터 2024년까지 인구는 줄고 지방세 세수는 늘어난 시군이 있나?"
  },
  {
    id: "smartfarm-policy",
    question: "상주에서 스마트팜 창업을 준비 중인 34세에게 맞는 정책은?"
  },
  {
    id: "council-change",
    question: "최근 5년간 도의회 지방소멸 논의는 어떻게 달라졌나?"
  },
  {
    id: "public-document",
    question: "인구·지방세 분석으로 정보공개청구서 초안을 작성해 줘."
  }
] as const;

interface RepresentativeDemoResponse {
  data_status: ResponseDataStatus;
  question: string;
  conclusion: string;
  evidence: Array<{
    statement: string;
    detail?: string | string[];
    sourceIds: string[];
    dataStatus?: string;
  }>;
  sources: SourceRef[];
  limitations: string[];
}

export async function runRepresentativeDemo(
  questionId: string,
  registry: ToolRegistry,
  context: ToolExecutionContext = {}
): Promise<RepresentativeDemoResponse> {
  if (questionId === "population-tax") {
    const response = await executeTool(
      registry,
      "compare_population_and_tax",
      {
        startYear: 2022,
        endYear: 2024
      },
      context
    );
    const result = response.result as {
      matches: Array<{
        regionName: string;
        populationTrend: { changePercent: number | null };
        taxTrend: { changePercent: number | null };
        populationSourceIds: string[];
        taxSourceIds: string[];
      }>;
      not_evaluable: Array<{
        regionName: string;
        notEvaluableReason: string;
        populationDataStatuses: string[];
        taxDataStatuses: string[];
        taxAmountSemantics: string[];
        populationSourceIds: string[];
        taxSourceIds: string[];
      }>;
    };
    const contextEvidence = result.not_evaluable.map((item) => ({
      statement: `${item.regionName}: 비교 결론 생성 안 함`,
      detail: [
        `사유: ${item.notEvaluableReason}`,
        `인구 상태: ${item.populationDataStatuses.join(", ") || "없음"}`,
        `지방세 상태: ${item.taxDataStatuses.join(", ") || "없음"}`,
        `지방세 의미: ${item.taxAmountSemantics.join(", ") || "없음"}`
      ],
      sourceIds: [...item.populationSourceIds, ...item.taxSourceIds],
      dataStatus: "incomparable"
    }));
    return {
      data_status: response.data_status,
      question: representativeQuestions[0].question,
      conclusion:
        result.matches.length > 0
          ? `${result.matches.map((item) => item.regionName).join(", ")}에서 비교 가능한 공식 인구 감소와 지방세 증가가 동시에 관측되었습니다.`
          : "비교 가능한 공식 시계열이 없어 인구 감소·지방세 증가 결론을 생성하지 않았습니다.",
      evidence: [
        ...result.matches.map((item) => ({
          statement: `[official_observed] ${item.regionName}: 인구 ${
            item.populationTrend.changePercent === null
              ? "증감률 계산 불가"
              : `${item.populationTrend.changePercent}%`
          }, 지방세 ${
            item.taxTrend.changePercent === null
              ? "증감률 계산 불가"
              : `${item.taxTrend.changePercent}%`
          }`,
          sourceIds: [...item.populationSourceIds, ...item.taxSourceIds],
          dataStatus: "official_observed"
        })),
        ...contextEvidence
      ],
      sources: response.sources,
      limitations: response.limitations
    };
  }

  if (questionId === "smartfarm-policy") {
    const response = await executeTool(
      registry,
      "search_policies",
      {
        region: "상주시",
        age: 34,
        query: "스마트팜",
        stage: "예비창업"
      },
      context
    );
    const result = response.result as {
      matches: Array<{
        policy: { title: string; policyId: string };
        eligible: boolean;
        reasons: string[];
        unmetConditions: string[];
      }>;
    };
    const eligible = result.matches.filter((item) => item.eligible);
    return {
      data_status: response.data_status,
      question: representativeQuestions[1].question,
      conclusion: `${response.data_status === "demo_sample" ? "데모" : "반환 데이터"} 기준으로 ${eligible.length}개 정책이 입력 조건에 부합합니다.`,
      evidence: result.matches.map((item) => ({
        statement: `${item.policy.title}: ${item.eligible ? "조건 부합" : "추가 조건 확인"}`,
        detail: [...item.reasons, ...item.unmetConditions],
        sourceIds: response.sources.map((source) => source.sourceId),
        dataStatus: response.data_status
      })),
      sources: response.sources,
      limitations: response.limitations
    };
  }

  if (questionId === "council-change") {
    const response = await executeTool(
      registry,
      "search_council_records",
      {
        query: "지방소멸 청년 생활인구",
        council: "경상북도의회",
        dateFrom: "2020-01-01",
        dateTo: "2024-12-31",
        limit: 10
      },
      context
    );
    const result = response.result as {
      matches: Array<{
        title: string;
        text: string;
        metadata: { meetingDate: string; sourceId: string };
      }>;
    };
    const sorted = [...result.matches].sort((a, b) =>
      a.metadata.meetingDate.localeCompare(b.metadata.meetingDate)
    );
    return {
      data_status: response.data_status,
      question: representativeQuestions[2].question,
      conclusion:
        `${response.data_status === "demo_sample" ? "데모 기록" : "검색 결과"}에서는 기반시설 중심 논의가 청년 정착, 성과관리, 생활인구·스마트농업으로 확장됩니다.`,
      evidence: sorted.map((item) => ({
        statement: `${item.metadata.meetingDate.slice(0, 4)} — ${item.title}`,
        detail: item.text,
        sourceIds: [item.metadata.sourceId],
        dataStatus: response.data_status
      })),
      sources: response.sources,
      limitations: response.limitations
    };
  }

  if (questionId === "public-document") {
    const analysis = await runRepresentativeDemo(
      "population-tax",
      registry,
      context
    );
    const sourceById = new Map(
      analysis.sources.map((source) => [source.sourceId, source])
    );
    const officialEvidence = analysis.evidence.filter(
      (item) =>
        item.dataStatus === "official_observed" &&
        item.sourceIds.length > 0 &&
        item.sourceIds.every((sourceId) => {
          const source = sourceById.get(sourceId);
          return Boolean(
            source &&
              source.isOfficial &&
              source.dataStatus !== "demo_sample"
          );
        })
    );
    if (officialEvidence.length === 0) {
      return {
        data_status: analysis.data_status,
        question: representativeQuestions[3].question,
        conclusion:
          "비교 가능한 공식 근거가 없어 공공문서 초안을 생성하지 않았습니다.",
        evidence: analysis.evidence,
        sources: analysis.sources,
        limitations: [
          ...analysis.limitations,
          "demo_sample 또는 비교 불가능한 시계열은 공공문서 근거로 사용하지 않습니다."
        ]
      };
    }
    const usedSourceIds = new Set(
      officialEvidence.flatMap((item) => item.sourceIds)
    );
    const officialSources = analysis.sources.filter((source) =>
      usedSourceIds.has(source.sourceId)
    );
    const response = await executeTool(
      registry,
      "draft_public_document",
      {
        documentType: "information_request",
        title: "시군별 인구 및 지방세 세수 산출 근거 공개 요청",
        verifiedAnalysis: {
          conclusion: analysis.conclusion,
          evidence: officialEvidence.map((item) => ({
            statement: item.statement,
            sourceIds: item.sourceIds
          })),
          sources: officialSources,
          limitations: analysis.limitations,
          verified: true
        }
      },
      context
    );
    const result = response.result as { draft: string };
    return {
      data_status: response.data_status,
      question: representativeQuestions[3].question,
      conclusion: "검증 묶음에 포함된 내용만으로 정보공개청구서 초안을 만들었습니다.",
      evidence: [
        {
          statement: result.draft,
          sourceIds: officialSources.map((source) => source.sourceId),
          dataStatus: response.data_status
        }
      ],
      sources: response.sources,
      limitations: response.limitations
    };
  }

  throw new Error(`알 수 없는 대표 질문입니다: ${questionId}`);
}
