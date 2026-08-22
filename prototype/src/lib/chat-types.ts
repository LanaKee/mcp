import type { AnswerView } from "./blocks";

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

export interface ChatTurn {
  id: string;
  question: string;
  status: "pending" | "done" | "error";
  reply: ChatReply | null;
  error: string | null;
  createdAt: number;
}
