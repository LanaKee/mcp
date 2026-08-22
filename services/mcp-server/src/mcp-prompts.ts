import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/**
 * Prompts carry the investigation procedure, not the answer.
 *
 * The safety properties this project cares about — never reading a plan figure
 * as an observation, never comparing series recorded on different bases, never
 * turning an absent record into a negative finding — live in the tools, but a
 * model still has to be told to reach for them in the right order. Shipping the
 * procedure as an MCP prompt means any client, not only this repository's web
 * app, runs the same sequence. Otherwise the guarantees hold in our demo and
 * nowhere else.
 */
interface PromptDefinition {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
  build: (args: Record<string, string>) => string;
}

const INVESTIGATE = `당신은 경상북도 공공데이터를 조사하는 분석가입니다. 아래 절차를 순서대로 따르고, 각 단계에서 도구가 돌려준 한계(limitations)를 그대로 유지하십시오.

1. search_datasets로 이 질문에 쓸 수 있는 데이터셋을 찾습니다. 무엇을 쓸지 추측하지 마십시오.
2. describe_dataset으로 후보 데이터셋의 측정 단위, 집계 수준, 증거 역할, 그리고 evidenceContract의 canClaim/cannotClaim을 확인합니다.
3. build_regional_evidence_pack으로 이 지역·현안의 관측 통계, 서술 맥락, 근거 공백을 한 번에 확보합니다.
4. 추세를 말해야 한다면 trace_policy_response로 계획·발표·논의·발의의 시간 순서를 확인합니다.
5. 다른 시군과 비교해야 한다면 compare_peer_regions를 사용하고, 비교 불가 사유가 돌아오면 순위를 만들지 말고 그 사유를 그대로 전달합니다.
6. 답변의 모든 문장에 해당 문장을 뒷받침한 source_id를 붙입니다.

반드시 지켜야 할 규칙:
- 보도자료, 회의록, 업무계획, 의안의 본문에 실린 수치는 계획치이거나 발언이며, 관측 통계로 인용할 수 없습니다.
- 도구가 데이터가 없다고 답하면, 그것은 "값이 0" 또는 "그런 일이 없었다"가 아니라 "적재된 자료로 확인할 수 없다"입니다. 그대로 말하십시오.
- 회계 기준·단위·집계 수준이 다른 수치를 나란히 놓거나 빼서 비교하지 마십시오.
- 확보한 근거로 답할 수 없으면, 추정하지 말고 무엇이 없어서 답할 수 없는지와 그 자료를 어디서 얻을 수 있는지를 답하십시오.

조사 대상
- 지역: {{region}}
- 현안: {{issue}}
{{extra}}`;

const DRAFT = `당신은 주민이 행정에 제출할 문서를 작성합니다. 문서는 확인된 근거만으로 구성되어야 하며, 확인되지 않은 주장을 담으면 그 문서는 반려되거나 잘못된 요구가 됩니다.

1. build_regional_evidence_pack으로 이 지역·현안의 근거와 근거 공백(gaps)을 확보합니다.
2. gaps의 wouldBeClosedBy와 holder를 확인합니다. 이것이 청구할 대상과 청구할 자료입니다.
3. draft_public_document로 문서를 생성하고, 본문의 각 주장에 source_id를 붙입니다.

작성 규칙:
- 성과나 실패에 대한 판단을 쓰지 마십시오. 적재된 자료에는 집행 실적과 성과지표가 없습니다.
- 관측 통계로 확인된 사실과, 계획·발표에서 인용한 내용을 문서 안에서 구분해 표기하십시오.
- 확인되지 않은 내용은 주장으로 쓰지 말고, 정보공개청구 항목으로 옮기십시오.
- 예산을 요구하는 제안서라면, 먼저 집행 내역을 청구해 확인한 뒤에 쓰는 것이 맞습니다. 아직 확인되지 않았다면 문서에 그 사실을 적으십시오.

작성 대상
- 지역: {{region}}
- 현안: {{issue}}
- 문서 종류: {{documentType}}`;

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) =>
    values[key] ?? ""
  );
}

const PROMPTS: PromptDefinition[] = [
  {
    name: "investigate_regional_issue",
    description:
      "지역 현안을 데이터로 조사하는 절차. 데이터셋 발견 → 의미 확인 → 근거 묶음 → 시간 순서 → 비교 가능성 검사 순으로 진행하며, 근거 없는 결론을 만들지 않도록 제약을 함께 전달합니다.",
    arguments: [
      { name: "region", description: "조사할 시군 또는 경상북도", required: true },
      { name: "issue", description: "조사할 현안 (예: 인구 감소, 청년 유출)", required: true },
      {
        name: "question",
        description: "구체적으로 답하고 싶은 질문 (선택)",
        required: false
      }
    ],
    build: (args) =>
      fill(INVESTIGATE, {
        region: args.region ?? "",
        issue: args.issue ?? "",
        extra: args.question ? `- 답해야 할 질문: ${args.question}` : ""
      })
  },
  {
    name: "draft_civic_action",
    description:
      "확인된 근거와 근거 공백을 바탕으로 정보공개청구서 또는 주민참여예산 제안서를 작성하는 절차. 확인되지 않은 내용을 주장 대신 청구 항목으로 옮기게 합니다.",
    arguments: [
      { name: "region", description: "대상 시군 또는 경상북도", required: true },
      { name: "issue", description: "대상 현안", required: true },
      {
        name: "documentType",
        description: "정보공개청구서 또는 주민참여예산 제안서",
        required: false
      }
    ],
    build: (args) =>
      fill(DRAFT, {
        region: args.region ?? "",
        issue: args.issue ?? "",
        documentType: args.documentType ?? "정보공개청구서"
      })
  }
];

export function registerPrompts(server: Server): void {
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map(({ name, description, arguments: args }) => ({
      name,
      description,
      arguments: args
    }))
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompt = PROMPTS.find((entry) => entry.name === request.params.name);
    if (!prompt) throw new Error(`알 수 없는 프롬프트입니다: ${request.params.name}`);
    const provided = request.params.arguments ?? {};
    const missing = prompt.arguments
      .filter((argument) => argument.required && !provided[argument.name])
      .map((argument) => argument.name);
    if (missing.length > 0) {
      throw new Error(`필수 인자가 없습니다: ${missing.join(", ")}`);
    }
    return {
      description: prompt.description,
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: prompt.build(provided as Record<string, string>)
          }
        }
      ]
    };
  });
}

export const PROMPT_NAMES = PROMPTS.map((prompt) => prompt.name);
