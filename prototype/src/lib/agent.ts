/**
 * 에이전트 응답 타입.
 *
 * `services/mcp-server/src/agent.ts`의 `AgentAnswer`를 화면이 쓰는 만큼만
 * 옮겨 적은 것이다. 전체를 복제하면 서버가 필드를 늘릴 때마다 프로토타입이
 * 깨지므로, 필수 필드만 좁게 선언하고 나머지는 그대로 통과시킨다.
 *
 * 근거는 이제 `mcp-agent.ts`가 MCP 프로토콜로 직접 모은다. 이 모듈에 남은
 * HTTP 호출은 추천 질문 목록뿐이다.
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
