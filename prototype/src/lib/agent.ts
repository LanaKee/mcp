/**
 * 에이전트 응답 타입.
 *
 * `services/mcp-server/src/agent.ts`의 `AgentAnswer`를 화면이 쓰는 만큼만
 * 옮겨 적은 것이다. 전체를 복제하면 서버가 필드를 늘릴 때마다 프로토타입이
 * 깨지므로, 필수 필드만 좁게 선언하고 나머지는 그대로 통과시킨다.
 */

export interface AgentEvidence {
  statement: string;
  datasetId: string;
  tool: string;
  dataStatus: string;
  sourceIds: string[];
  evidenceContract?: {
    role?: string;
    canClaim?: string[];
    cannotClaim?: string[];
    insteadUse?: string;
  };
  detail?: unknown;
}

export interface AgentPlanStep {
  datasetId: string;
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
}

export interface AgentAnswer {
  question: string;
  planner: string;
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
  joins: Array<{
    from: string;
    to: string;
    joinKeys: string[];
    rationale: string;
    caveats: string[];
  }>;
  sources: Array<{
    sourceId?: string;
    title?: string;
    publisher?: string;
    retrievedAt?: string;
    url?: string;
    [key: string]: unknown;
  }>;
  limitations: string[];
  rejectedSteps: Array<{ step: AgentPlanStep; reason: string }>;
  unavailableDatasets: Array<{ datasetId: string; title: string; note: string | null }>;
}

export class AgentUnavailableError extends Error {
  constructor(
    message: string,
    readonly detail: string
  ) {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

function baseUrl(): string {
  return (process.env.MCP_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/u, "");
}

function authHeaders(): Record<string, string> {
  const token = process.env.MCP_AUTH_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * 에이전트에 질문을 넘긴다.
 *
 * 서버가 없거나 오류를 돌려주면 화면에서 사실을 지어내지 않도록
 * {@link AgentUnavailableError}로 올린다. 프로토타입이라도 데이터가 없을 때
 * 그럴듯한 답을 만드는 쪽이 이 프로젝트에서는 가장 큰 실패다.
 */
export async function askAgent(question: string, signal?: AbortSignal): Promise<AgentAnswer> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/api/agent`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ question }),
      signal,
      cache: "no-store"
    });
  } catch (error) {
    throw new AgentUnavailableError(
      "데이터 백엔드에 연결하지 못했습니다.",
      `${baseUrl()}/api/agent 요청 실패: ${(error as Error).message}`
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AgentUnavailableError(
      "에이전트가 요청을 거절했습니다.",
      `HTTP ${response.status} ${response.statusText} ${body.slice(0, 400)}`
    );
  }
  return (await response.json()) as AgentAnswer;
}

export async function fetchQuestions(): Promise<Array<{ id: string; question: string }>> {
  try {
    const response = await fetch(`${baseUrl()}/api/questions`, {
      headers: authHeaders(),
      cache: "no-store"
    });
    if (!response.ok) return [];
    const body = (await response.json()) as {
      questions?: Array<{ id: string; question: string }>;
    };
    return body.questions ?? [];
  } catch {
    return [];
  }
}
