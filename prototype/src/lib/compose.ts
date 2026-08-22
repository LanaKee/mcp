import type { AgentAnswer } from "./agent";
import {
  answerViewSchema,
  blockSchema,
  BLOCK_SCHEMA_HINT,
  type AnswerView,
  type Block
} from "./blocks";
import { fallbackView } from "./fallback";
import { completedBlocks, completedSummary } from "./stream-json";

/**
 * 에이전트가 모은 근거를 사람이 보기 좋은 카드로 옮기는 단계.
 *
 * 이 단계는 **새 사실을 만들지 않는다**. 모델에게 주어지는 것은 에이전트가
 * 실제 도구 호출로 받은 값뿐이고, 요구하는 출력은 문장이 아니라 렌더링 가능한
 * 블록 JSON이다. 모델이 계산이나 추정을 하면 근거와 화면이 어긋나므로,
 * 프롬프트에서 수치는 그대로 옮기라고 못 박고 스키마 검증으로 한 번 더 거른다.
 */

const MODEL = () => process.env.PROTOTYPE_MODEL ?? "claude-sonnet-5";

export interface ComposeResult {
  view: AnswerView;
  composer: string;
  /** 모델이 실패해 결정적 렌더러로 그렸을 때의 사유. */
  degraded: string | null;
}

export interface ComposeStreamHandlers {
  /** 요약 문장이 완성되는 즉시. */
  onSummary?: (summary: string) => void;
  /** 블록 하나가 닫히는 즉시. 화면은 이것을 받아 카드를 하나씩 채운다. */
  onBlock?: (block: Block) => void;
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
6. answered가 true이면 unavailableDatasets를 화면에 언급하지 마세요. 답이 나온 이상
   비어 있는 데이터셋은 이용자의 질문이 아니라 적재 상태에 관한 내부 사정이며,
   경로 패널에 이미 표시됩니다.
7. limitations가 있으면 마지막에 bullets(tone "caution") 블록 하나로 정리하세요.
8. 줄글 문단 대신 metric, metricGrid, briefing, scenario, series, table을 우선 사용하세요.
   - 사람의 조건(나이·지역·업종)에 대한 해당 여부를 정리할 때는 briefing을 씁니다.
   - 여러 전제 중 하나를 고르는 추정이라면 scenario를 쓰되, 각 선택지의 값이 근거에
     있을 때만 씁니다. 없는 시나리오를 지어내지 마세요.
9. 첫 블록은 headline으로 시작합니다. 모든 문자열은 한국어로 씁니다.

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

async function requestClaude(text: string, stream: boolean, signal?: AbortSignal) {
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
      model: MODEL(),
      max_tokens: 4096,
      messages: [{ role: "user", content: text }],
      ...(stream ? { stream: true } : {})
    }),
    signal
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText} ${detail.slice(0, 200)}`);
  }
  return response;
}

async function callClaude(text: string, signal?: AbortSignal): Promise<string> {
  const response = await requestClaude(text, false, signal);
  const body = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
  const content = (body.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
  if (!content) throw new Error("모델 응답이 비어 있습니다.");
  return content;
}

/** 토큰이 오는 대로 흘려보낸다. 대기 시간을 숨기지 않고 진행을 보여주기 위해서다. */
async function callClaudeStreaming(
  text: string,
  onDelta: (chunk: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const response = await requestClaude(text, true, signal);
  if (!response.body) throw new Error("스트리밍 응답 본문이 없습니다.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 프레임은 빈 줄로 끝난다. 중간에 잘린 프레임은 버퍼에 남긴다.
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]" || payload.length === 0) continue;
        try {
          const event = JSON.parse(payload) as {
            type?: string;
            delta?: { type?: string; text?: string };
          };
          if (event.type === "content_block_delta" && typeof event.delta?.text === "string") {
            full += event.delta.text;
            onDelta(event.delta.text);
          }
        } catch {
          // 파싱 못 한 프레임은 건너뛴다. 본문 전체는 마지막에 다시 검증한다.
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  if (full.trim().length === 0) throw new Error("모델 응답이 비어 있습니다.");
  return full;
}

function validate(raw: unknown, answer: AgentAnswer): ComposeResult {
  const parsed = answerViewSchema.safeParse(raw);
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
  return { view: parsed.data, composer: MODEL(), degraded: null };
}

export async function composeView(
  answer: AgentAnswer,
  signal?: AbortSignal
): Promise<ComposeResult> {
  try {
    return validate(extractJson(await callClaude(prompt(answer), signal)), answer);
  } catch (error) {
    return {
      view: fallbackView(answer),
      composer: "deterministic",
      degraded: `${MODEL()} 호출 실패: ${(error as Error).message}`
    };
  }
}

/**
 * 카드를 완성되는 순서대로 흘려보내며 구성한다.
 *
 * 중간에 내보내는 블록은 미리보기다. 마지막에 응답 전체를 다시 검증해서 최종
 * 뷰를 돌려주고, 화면은 그것으로 교체한다. 스트리밍이 검증을 건너뛰는 뒷문이
 * 되면 안 되기 때문이다.
 */
export async function composeViewStream(
  answer: AgentAnswer,
  handlers: ComposeStreamHandlers = {},
  signal?: AbortSignal
): Promise<ComposeResult> {
  let emittedBlocks = 0;
  let emittedSummary = false;
  let accumulated = "";

  try {
    const raw = await callClaudeStreaming(
      prompt(answer),
      (chunk) => {
        accumulated += chunk;
        if (!emittedSummary) {
          const summary = completedSummary(accumulated);
          if (summary) {
            emittedSummary = true;
            handlers.onSummary?.(summary);
          }
        }
        const blocks = completedBlocks(accumulated);
        for (let index = emittedBlocks; index < blocks.length; index += 1) {
          const text = blocks[index];
          if (!text) continue;
          try {
            const candidate = blockSchema.safeParse(JSON.parse(text));
            if (candidate.success) handlers.onBlock?.(candidate.data);
          } catch {
            // 미리보기 실패는 조용히 넘어간다. 최종 검증이 진실이다.
          }
        }
        emittedBlocks = blocks.length;
      },
      signal
    );
    return validate(extractJson(raw), answer);
  } catch (error) {
    return {
      view: fallbackView(answer),
      composer: "deterministic",
      degraded: `${MODEL()} 호출 실패: ${(error as Error).message}`
    };
  }
}
