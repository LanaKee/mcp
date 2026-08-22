import { NextResponse } from "next/server";
import { askAgent, AgentUnavailableError } from "@/lib/agent";
import { composeView } from "@/lib/compose";
import { loadRepoEnv } from "@/lib/env";
import { composeQuestion, personaSchema } from "@/lib/persona";
import type { ChatReply } from "@/lib/chat-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * 화면이 쓰는 단 하나의 엔드포인트.
 *
 * 순서가 곧 이 프로토타입의 주장이다. 먼저 MCP 에이전트가 카탈로그를 검색하고
 * 도구를 골라 **데이터에서** 근거를 모으고, 그 다음에야 모델이 그 근거를 카드로
 * 옮긴다. 모델은 답을 만들지 않고 이미 확보된 근거의 표현만 담당한다.
 */
export async function POST(request: Request): Promise<NextResponse> {
  loadRepoEnv();

  const payload = (await request.json().catch(() => null)) as {
    message?: unknown;
    persona?: unknown;
  } | null;
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  if (message.length === 0 || message.length > 400) {
    return NextResponse.json({ error: "질문은 1자 이상 400자 이하여야 합니다." }, { status: 400 });
  }
  const persona = personaSchema.parse(payload?.persona ?? {});
  const question = composeQuestion(persona, message);

  try {
    const answer = await askAgent(question);
    const composed = await composeView(answer);
    const reply: ChatReply = {
      question,
      answered: answer.answered,
      planner: answer.planner,
      composer: composed.composer,
      degraded: composed.degraded,
      view: composed.view,
      route: {
        consideredDatasets: answer.consideredDatasets,
        plan: answer.plan,
        rejectedSteps: answer.rejectedSteps.map((item) => ({
          step: { tool: item.step.tool, datasetId: item.step.datasetId },
          reason: item.reason
        })),
        unavailableDatasets: answer.unavailableDatasets,
        joins: answer.joins,
        evidenceCount: answer.evidence.length,
        sourceCount: answer.sources.length
      },
      sources: answer.sources.slice(0, 12).map((source) => ({
        id: String(source.sourceId ?? ""),
        title: String(source.title ?? source.publisher ?? "출처"),
        publisher: source.publisher ? String(source.publisher) : null,
        retrievedAt: source.retrievedAt ? String(source.retrievedAt) : null
      })),
      limitations: answer.limitations
    };
    return NextResponse.json(reply);
  } catch (error) {
    if (!(error instanceof AgentUnavailableError)) throw error;
    // 백엔드가 없을 때 모델에게 답을 시키면 그럴듯한 거짓말이 나온다.
    // 여기서는 연결 실패 자체를 화면에 그린다.
    const reply: ChatReply = {
      question,
      answered: false,
      planner: "unavailable",
      composer: "none",
      degraded: error.detail,
      view: {
        summary: error.message,
        blocks: [
          {
            kind: "callout",
            tone: "danger",
            title: error.message,
            text: "MCP 서버가 응답하지 않아 근거를 가져오지 못했습니다. 근거 없이 답을 지어내지 않습니다. 서버를 실행한 뒤 다시 시도하세요."
          }
        ]
      },
      route: {
        consideredDatasets: [],
        plan: [],
        rejectedSteps: [],
        unavailableDatasets: [],
        joins: [],
        evidenceCount: 0,
        sourceCount: 0
      },
      sources: [],
      limitations: []
    };
    return NextResponse.json(reply, { status: 200 });
  }
}
