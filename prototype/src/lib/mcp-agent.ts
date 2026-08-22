import type { AgentAnswer, AgentEvidence, AgentPlanStep } from "./agent";
import { AgentUnavailableError } from "./agent";

/**
 * 네이티브 MCP 도구 호출로 근거를 모으는 경로.
 *
 * 이전에는 우리가 직접 카탈로그를 검색하고, 후보를 프롬프트에 적어 넣고,
 * 모델에게 "이 중에서 골라"라고 시킨 뒤 그 JSON을 파싱해 도구를 대신 호출했다.
 * 도구를 부를 줄 아는 모델에게 도구를 설명한 글을 읽히고 있었던 셈이다. 그
 * 번역 계층마다 실패가 하나씩 있었다. 카탈로그 어휘 게이트가 후보를 막고,
 * 플래너가 한 번에 한 단계씩만 세우고, 중간 결과를 보고 다음 호출을 정하지
 * 못했다.
 *
 * 여기서는 모델을 MCP 서버에 직접 붙인다. 도구 목록·스키마·결과가 모두
 * 프로토콜을 통해 오가므로 모델은 결과를 보고 다음 호출을 결정할 수 있고,
 * 우리가 옮겨 적을 것이 없다.
 *
 * 화면 계약은 그대로 둔다. 이 함수가 돌려주는 것은 기존과 같은
 * {@link AgentAnswer}이므로 구성 단계와 렌더러는 무엇이 바뀌었는지 모른다.
 */

const MCP_SERVER_URL = () =>
  process.env.MCP_SERVER_URL ?? "https://use.me.kr/mcp";
const TOOL_MODEL = () => process.env.PLANNER_MODEL ?? "gpt-5.6-sol";
const OPENAI_BASE_URL = () =>
  (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/u, "");

/** 모델이 한 질문에 쓸 수 있는 도구 호출 수. 무한 루프를 막는 상한이다. */
const MAX_TOOL_CALLS = 12;

const INSTRUCTIONS = `당신은 경상북도 공공데이터 분석가입니다. 연결된 MCP 서버의 도구만이 사실의 출처입니다.

원칙:
1. 어떤 수치도 기억이나 추정으로 말하지 않습니다. 도구가 돌려준 값만 인용합니다.
2. 어디에 무엇이 있는지 모르면 search_datasets로 먼저 확인하고, 그 결과가 가리키는 도구를 호출합니다.
3. 한 번의 호출로 부족하면 결과를 보고 이어서 호출합니다. 부분적인 답은 실패가 아닙니다.
4. 도구가 빈 결과를 돌려주면 다른 도구나 다른 검색어를 시도하고, 그래도 없으면 없다고 말합니다.
5. 측정 기준·회계 기준·단위가 다른 값을 이어 붙여 증감률을 계산하지 않습니다. 도구가 경고하면 그 경고를 답에 옮깁니다.
6. 서술 자료(보도자료·의안·회의록·문서)는 맥락의 근거일 뿐 수치의 근거가 아닙니다.
7. 답은 한국어로, 무엇을 확인했고 무엇은 확인하지 못했는지 분명히 구분해 씁니다.`;

export interface McpRunHandlers {
  /** 모델의 추론 요약이 흘러나올 때. 대기 시간을 설명하기 위한 것이다. */
  onReasoning?: (delta: string) => void;
  /** 모델이 도구 하나를 실제로 호출했을 때. */
  onToolCall?: (call: {
    tool: string;
    datasetId: string;
    arguments: Record<string, unknown>;
    /** 모델은 호출마다 이유를 따로 대지 않는다. 추론 요약이 그 자리를 대신한다. */
    reason: string;
  }) => void;
  /** 도구 호출이 끝나 결과가 돌아왔을 때. */
  onToolResult?: (result: { tool: string; ok: boolean; sourceCount: number }) => void;
}

interface McpCallRecord {
  tool: string;
  argumentsJson: string;
  output: string | null;
  error: string | null;
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 도구 결과 어디에 박혀 있든 출처 식별자를 긁어모은다.
 *
 * 도구마다 결과 모양이 달라 `sourceId`가 시계열 포인트 안에 있기도 하고
 * 문서 목록 안에 있기도 하다. 출처 없는 문장은 이 프로젝트에서 쓸 수 없으므로
 * 모양을 가정하지 않고 전부 훑는다.
 */
function collectSourceIds(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSourceIds(item, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "sourceId" || key === "source_id") && typeof child === "string") {
      into.add(child);
    } else if (key === "sourceIds" && Array.isArray(child)) {
      for (const id of child) if (typeof id === "string") into.add(id);
    } else {
      collectSourceIds(child, into);
    }
  }
}

/** 결과에서 데이터셋 이름을 찾는다. 없으면 도구 이름이 곧 출처 설명이 된다. */
function datasetOf(args: Record<string, unknown>, output: unknown): string {
  const fromArgs = args.datasetId;
  if (typeof fromArgs === "string" && fromArgs.length > 0) return fromArgs;
  const result = (output as { result?: Record<string, unknown> } | null)?.result;
  const fromResult = result?.datasetId;
  if (typeof fromResult === "string" && fromResult.length > 0) return fromResult;
  return "";
}

function dataStatusOf(output: unknown): string {
  const status = (output as { data_status?: unknown } | null)?.data_status;
  return typeof status === "string" ? status : "unknown";
}

/** search_datasets 결과를 라우트 패널이 쓰는 후보 목록으로 옮긴다. */
function consideredFrom(records: McpCallRecord[]): AgentAnswer["consideredDatasets"] {
  const considered: AgentAnswer["consideredDatasets"] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (record.tool !== "search_datasets") continue;
    const parsed = parseJson(record.output) as {
      result?: { datasets?: Array<Record<string, unknown>> };
    } | null;
    for (const dataset of parsed?.result?.datasets ?? []) {
      const id = typeof dataset.datasetId === "string" ? dataset.datasetId : "";
      if (id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      const coverage = dataset.coverage as { available?: unknown } | undefined;
      considered.push({
        datasetId: id,
        title: typeof dataset.title === "string" ? dataset.title : id,
        matchedTerms: Array.isArray(dataset.matchedTerms)
          ? dataset.matchedTerms.filter((term): term is string => typeof term === "string")
          : [],
        available: coverage?.available === true
      });
    }
  }
  return considered;
}

/**
 * 실패한 호출은 버리지 않고 남긴다.
 *
 * 도구가 빈 결과를 돌려준 사실 자체가 화면에 그릴 값어치가 있다. "그 데이터는
 * 없다"와 "찾아보지 않았다"는 전혀 다른 말이기 때문이다.
 */
function toAnswer(
  question: string,
  records: McpCallRecord[],
  conclusion: string
): AgentAnswer {
  const plan: AgentPlanStep[] = [];
  const evidence: AgentEvidence[] = [];
  const rejectedSteps: AgentAnswer["rejectedSteps"] = [];
  const sourceIds = new Set<string>();

  for (const record of records) {
    const args = (parseJson(record.argumentsJson) as Record<string, unknown>) ?? {};
    const output = parseJson(record.output);
    const datasetId = datasetOf(args, output);
    const step: AgentPlanStep = {
      datasetId,
      tool: record.tool,
      arguments: args,
      reason: ""
    };
    plan.push(step);

    if (record.error !== null || output === null) {
      rejectedSteps.push({ step, reason: record.error ?? "도구가 읽을 수 없는 응답을 돌려주었습니다." });
      continue;
    }
    const ids = new Set<string>();
    collectSourceIds(output, ids);
    for (const id of ids) sourceIds.add(id);
    evidence.push({
      statement: `${record.tool} 호출 결과`,
      datasetId,
      tool: record.tool,
      dataStatus: dataStatusOf(output),
      sourceIds: [...ids],
      detail: (output as { result?: unknown }).result ?? output
    });
  }

  return {
    question,
    planner: `mcp:${TOOL_MODEL()}`,
    consideredDatasets: consideredFrom(records),
    plan,
    // 도구를 한 번도 성공적으로 부르지 못했으면 남은 글은 근거 없는 문장이다.
    answered: evidence.length > 0 && conclusion.trim().length > 0,
    conclusion: conclusion.trim(),
    evidence,
    joins: [],
    sources: [...sourceIds].map((id) => ({ sourceId: id })),
    limitations: [],
    rejectedSteps,
    unavailableDatasets: []
  };
}

interface StreamEvent {
  type?: string;
  delta?: string;
  item?: Record<string, unknown>;
  response?: { error?: { message?: string } | null };
  message?: string;
}

/** Responses 스트림의 한 줄을 뜯는다. 모르는 이벤트는 조용히 흘려보낸다. */
function parseEventLine(line: string): StreamEvent | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (payload.length === 0 || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as StreamEvent;
  } catch {
    return null;
  }
}

/**
 * 질문 하나를 MCP 서버에 붙은 모델에게 넘기고, 그 과정을 흘려보낸다.
 */
export async function askViaMcp(
  question: string,
  handlers: McpRunHandlers = {},
  signal?: AbortSignal
): Promise<AgentAnswer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new AgentUnavailableError(
      "도구 선택 모델 자격 증명이 없습니다.",
      "OPENAI_API_KEY가 설정되지 않아 MCP 도구 호출을 시작할 수 없습니다."
    );
  }

  const body = {
    model: TOOL_MODEL(),
    instructions: INSTRUCTIONS,
    input: question,
    stream: true,
    reasoning: { summary: "auto" },
    max_tool_calls: MAX_TOOL_CALLS,
    tools: [
      {
        type: "mcp",
        server_label: "gyeongbuk",
        server_url: MCP_SERVER_URL(),
        // 승인 절차를 두면 스트림이 멈춘 채 사람을 기다린다. 이 서버는 우리가
        // 운영하는 읽기 전용 공공데이터 서버이므로 승인 없이 진행한다.
        require_approval: "never"
      }
    ]
  };

  let response: Response;
  try {
    response = await fetch(`${OPENAI_BASE_URL()}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal,
      cache: "no-store"
    });
  } catch (error) {
    throw new AgentUnavailableError(
      "도구 선택 모델에 연결하지 못했습니다.",
      `${OPENAI_BASE_URL()}/responses 요청 실패: ${(error as Error).message}`
    );
  }
  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => "");
    throw new AgentUnavailableError(
      "도구 선택 모델이 요청을 거절했습니다.",
      `HTTP ${response.status} ${response.statusText} ${detail.slice(0, 400)}`
    );
  }

  const records: McpCallRecord[] = [];
  let conclusion = "";
  let failure: string | null = null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    // SSE는 빈 줄로 이벤트를 끊는다. 마지막 조각은 다음 청크와 이어 붙인다.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseEventLine(line.trim());
      if (event === null) continue;
      switch (event.type) {
        case "response.reasoning_summary_text.delta":
          if (typeof event.delta === "string") handlers.onReasoning?.(event.delta);
          break;
        case "response.output_text.delta":
          if (typeof event.delta === "string") conclusion += event.delta;
          break;
        case "response.output_item.done": {
          const item = event.item;
          if (item?.type !== "mcp_call") break;
          const tool = typeof item.name === "string" ? item.name : "unknown";
          const argumentsJson = typeof item.arguments === "string" ? item.arguments : "{}";
          const output = typeof item.output === "string" ? item.output : null;
          const error =
            item.error === null || item.error === undefined
              ? null
              : typeof item.error === "string"
                ? item.error
                : JSON.stringify(item.error);
          const record: McpCallRecord = { tool, argumentsJson, output, error };
          records.push(record);
          const args = (parseJson(argumentsJson) as Record<string, unknown>) ?? {};
          const parsedOutput = parseJson(output);
          handlers.onToolCall?.({
            tool,
            datasetId: datasetOf(args, parsedOutput),
            arguments: args,
            reason: ""
          });
          const ids = new Set<string>();
          collectSourceIds(parsedOutput, ids);
          handlers.onToolResult?.({
            tool,
            ok: error === null && parsedOutput !== null,
            sourceCount: ids.size
          });
          break;
        }
        case "response.failed":
        case "error":
          failure = event.response?.error?.message ?? event.message ?? "알 수 없는 오류";
          break;
        case "response.completed":
          done = true;
          break;
        default:
          break;
      }
    }
  }

  if (failure !== null && records.length === 0) {
    throw new AgentUnavailableError("도구 호출이 중단되었습니다.", failure);
  }
  return toAnswer(question, records, conclusion);
}
