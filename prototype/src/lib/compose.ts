import type { AgentAnswer } from "./agent";
import { answerViewSchema, BLOCK_SCHEMA_HINT, type AnswerView } from "./blocks";
import { fallbackView } from "./fallback";

/**
 * 에이전트가 모은 근거를 사람이 보기 좋은 카드로 옮기는 단계.
 *
 * 이 단계는 **새 사실을 만들지 않는다**. 모델에게 주어지는 것은 에이전트가
 * 실제 도구 호출로 받은 값뿐이고, 요구하는 출력은 문장이 아니라 렌더링 가능한
 * 블록 JSON이다. 모델이 계산이나 추정을 하면 근거와 화면이 어긋나므로,
 * 프롬프트에서 수치는 그대로 옮기라고 못 박고 스키마 검증으로 한 번 더 거른다.
 */

const MODEL = process.env.PROTOTYPE_MODEL ?? "claude-sonnet-5";

export interface ComposeResult {
  view: AnswerView;
  composer: string;
  /** 모델이 실패해 결정적 렌더러로 그렸을 때의 사유. */
  degraded: string | null;
}

/** 프롬프트에 넣기 위해 근거를 줄인다. 원본 detail은 수십 KB가 될 수 있다. */
function digest(answer: AgentAnswer): string {
  const compact = {
    question: answer.question,
    answered: answer.answered,
    conclusion: answer.conclusion,
    consideredDatasets: answer.consideredDatasets,
    plan: answer.plan.map((step) => ({
      dataset: step.datasetId,
      tool: step.tool,
      arguments: step.arguments,
      reason: step.reason
    })),
    evidence: answer.evidence.map((item) => ({
      statement: item.statement,
      dataset: item.datasetId,
      tool: item.tool,
      dataStatus: item.dataStatus,
      canClaim: item.evidenceContract?.canClaim ?? [],
      cannotClaim: item.evidenceContract?.cannotClaim ?? [],
      detail: item.detail
    })),
    joins: answer.joins,
    unavailableDatasets: answer.unavailableDatasets,
    rejectedSteps: answer.rejectedSteps.map((item) => ({
      tool: item.step.tool,
      reason: item.reason
    })),
    limitations: answer.limitations,
    sourceCount: answer.sources.length
  };
  const text = JSON.stringify(compact);
  // 프롬프트 상한. 잘릴 경우 모델이 부분 JSON을 사실로 읽지 않도록 표시한다.
  return text.length > 60_000 ? `${text.slice(0, 60_000)}\n...[근거가 길어 잘렸습니다]` : text;
}

function prompt(answer: AgentAnswer): string {
  return `당신은 경상북도 공공데이터 브리핑 화면을 구성합니다.

아래 JSON은 MCP 에이전트가 **실제 데이터베이스 도구를 호출해 받은 결과**입니다.
이것을 사람이 한눈에 읽을 수 있는 화면 블록으로 옮기는 것이 당신의 일입니다.

규칙:
1. JSON 객체 하나만 출력합니다. 코드펜스, 설명, 인사말을 붙이지 마세요.
2. 근거에 없는 수치·지역·연도·기관명을 만들지 마세요. 숫자는 evidence.detail에 있는 값을 그대로 옮깁니다.
3. 직접 계산하지 마세요. 증감·비율은 detail에 이미 있는 값만 사용합니다.
4. evidence[].cannotClaim에 적힌 주장은 어떤 블록에도 넣지 마세요.
5. answered가 false이면 headline과 callout(tone "warn")으로 무엇이 없어 답할 수 없는지 밝히세요.
6. unavailableDatasets가 있으면 비어 있다는 사실을 callout으로 반드시 노출하세요.
7. limitations가 있으면 마지막에 bullets(tone "caution") 블록 하나로 정리하세요.
8. 줄글 문단 대신 metric, metricGrid, series, table을 우선 사용하세요. 블록은 최대 8개입니다.
9. 모든 문자열은 한국어로 씁니다.

출력 형식:
${BLOCK_SCHEMA_HINT}

에이전트 결과:
${digest(answer)}`;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("응답에서 JSON 객체를 찾지 못했습니다.");
  return JSON.parse(body.slice(start, end + 1));
}

async function callClaude(text: string, signal?: AbortSignal): Promise<string> {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error("CLAUDE_API_KEY가 설정되지 않았습니다.");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: text }]
    }),
    signal
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText} ${detail.slice(0, 200)}`);
  }
  const body = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
  const content = (body.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
  if (!content) throw new Error("모델 응답이 비어 있습니다.");
  return content;
}

export async function composeView(
  answer: AgentAnswer,
  signal?: AbortSignal
): Promise<ComposeResult> {
  try {
    const raw = await callClaude(prompt(answer), signal);
    const parsed = answerViewSchema.safeParse(extractJson(raw));
    if (!parsed.success) {
      return {
        view: fallbackView(answer),
        composer: "deterministic",
        degraded: `모델 응답이 화면 스키마를 벗어났습니다: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join(", ")}`
      };
    }
    return { view: parsed.data, composer: MODEL, degraded: null };
  } catch (error) {
    return {
      view: fallbackView(answer),
      composer: "deterministic",
      degraded: `${MODEL} 호출 실패: ${(error as Error).message}`
    };
  }
}
