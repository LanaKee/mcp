import type { AnswerView, Block } from "./blocks";

export interface RouteTrace {
  consideredDatasets: Array<{
    datasetId: string;
    title: string;
    matchedTerms: string[];
    available: boolean;
  }>;
  plan: Array<{
    datasetId: string;
    tool: string;
    arguments: Record<string, unknown>;
    reason: string;
  }>;
  rejectedSteps: Array<{ step: { tool: string; datasetId: string }; reason: string }>;
  unavailableDatasets: Array<{ datasetId: string; title: string; note: string | null }>;
  joins: Array<{ from: string; to: string; joinKeys: string[]; rationale: string; caveats: string[] }>;
  evidenceCount: number;
  sourceCount: number;
}

export interface ChatReply {
  question: string;
  answered: boolean;
  /** 도구를 고른 플래너. */
  planner: string;
  /** 근거를 카드로 옮긴 모델. */
  composer: string;
  degraded: string | null;
  view: AnswerView;
  route: RouteTrace;
  sources: Array<{
    id: string;
    title: string;
    publisher: string | null;
    retrievedAt: string | null;
  }>;
  limitations: string[];
}

/** 진행 단계. 화면은 이것을 순서대로 켜서 대기 시간을 설명한다. */
export type StageId = "plan" | "collect" | "compose";

export interface StageEvent {
  id: StageId;
  label: string;
  state: "running" | "done";
  /** 그 단계에서 실제로 일어난 일. 없는 사실을 지어 쓰지 않는다. */
  detail?: string;
}

/**
 * 서버가 흘려보내는 이벤트.
 *
 * 사람이 수십 초를 빈 화면으로 기다리게 두지 않기 위한 것이지만, 그렇다고 진행
 * 표시를 지어내지는 않는다. `stage`는 실제 단계 전환에서, `tool`은 플래너가
 * 실제로 고른 호출에서, `block`은 모델이 카드 하나를 닫는 순간에 나간다.
 */
export type ChatEvent =
  | { type: "stage"; stage: StageEvent }
  | {
      type: "tool";
      datasetId: string;
      tool: string;
      arguments: Record<string, unknown>;
      reason: string;
    }
  | { type: "summary"; summary: string }
  | { type: "block"; block: Block }
  | { type: "done"; reply: ChatReply }
  | { type: "error"; message: string };

export interface ChatTurn {
  id: string;
  question: string;
  status: "pending" | "done" | "error";
  reply: ChatReply | null;
  error: string | null;
  createdAt: number;
  /** 스트리밍 중에만 채워지는 진행 상태. 완료되면 reply가 진실이다. */
  progress?: {
    stages: StageEvent[];
    tools: Array<{ tool: string; datasetId: string; reason: string }>;
    summary: string | null;
    blocks: Block[];
  };
}
