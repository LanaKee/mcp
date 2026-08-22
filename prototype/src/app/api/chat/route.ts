import { askAgent, AgentUnavailableError, type AgentAnswer } from "@/lib/agent";
import { composeViewStream } from "@/lib/compose";
import { loadRepoEnv } from "@/lib/env";
import { composeQuestion, personaSchema } from "@/lib/persona";
import type { ChatEvent, ChatReply } from "@/lib/chat-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 화면이 쓰는 단 하나의 엔드포인트. 서버-전송 이벤트로 진행을 흘려보낸다.
 *
 * 순서가 곧 이 프로토타입의 주장이다. 먼저 MCP 에이전트가 카탈로그를 검색하고
 * 도구를 골라 **데이터에서** 근거를 모으고, 그 다음에야 모델이 그 근거를 카드로
 * 옮긴다. 모델은 답을 만들지 않고 이미 확보된 근거의 표현만 담당한다.
 *
 * 두 모델을 거치므로 응답까지 수십 초가 걸린다. 그 시간을 빈 화면으로 두는 대신
 * 실제로 일어난 일(고른 도구, 닫힌 카드)을 그때그때 내보낸다. 진행 표시를
 * 지어내지 않는 것이 조건이다.
 */
export async function POST(request: Request): Promise<Response> {
  loadRepoEnv();

  const payload = (await request.json().catch(() => null)) as {
    message?: unknown;
    persona?: unknown;
  } | null;
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  if (message.length === 0 || message.length > 400) {
    return Response.json({ error: "질문은 1자 이상 400자 이하여야 합니다." }, { status: 400 });
  }
  const persona = personaSchema.parse(payload?.persona ?? {});
  const question = composeQuestion(persona, message);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: ChatEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        send({
          type: "stage",
          stage: {
            id: "plan",
            label: "카탈로그를 검색하고 도구를 고르는 중",
            state: "running"
          }
        });

        const answer = await askAgent(question, request.signal);

        send({
          type: "stage",
          stage: {
            id: "plan",
            label: "도구 선택 완료",
            state: "done",
            detail: `${answer.planner} · 후보 ${answer.consideredDatasets.length}개 · 호출 ${answer.plan.length}건`
          }
        });
        for (const step of answer.plan) {
          send({
            type: "tool",
            datasetId: step.datasetId,
            tool: step.tool,
            arguments: step.arguments,
            reason: step.reason
          });
        }
        send({
          type: "stage",
          stage: {
            id: "collect",
            label: "데이터에서 근거를 모았습니다",
            state: "done",
            detail: `근거 ${answer.evidence.length}건 · 출처 ${answer.sources.length}건`
          }
        });
        send({
          type: "stage",
          stage: { id: "compose", label: "브리핑 화면을 그리는 중", state: "running" }
        });

        const composed = await composeViewStream(
          answer,
          {
            onSummary: (summary) => send({ type: "summary", summary }),
            onBlock: (block) => send({ type: "block", block })
          },
          request.signal
        );

        send({
          type: "stage",
          stage: {
            id: "compose",
            label: "브리핑 완성",
            state: "done",
            detail: `${composed.composer} · 카드 ${composed.view.blocks.length}장`
          }
        });
        send({ type: "done", reply: toReply(question, answer, composed) });
      } catch (error) {
        if (error instanceof AgentUnavailableError) {
          // 백엔드가 없을 때 모델에게 답을 시키면 그럴듯한 거짓말이 나온다.
          // 여기서는 연결 실패 자체를 화면에 그린다.
          send({ type: "done", reply: unavailableReply(question, error) });
        } else {
          send({ type: "error", message: (error as Error).message });
        }
      } finally {
        closed = true;
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // 프록시가 SSE를 모아 두면 스트리밍의 의미가 사라진다.
      "x-accel-buffering": "no"
    }
  });
}

function toReply(
  question: string,
  answer: AgentAnswer,
  composed: { view: ChatReply["view"]; composer: string; degraded: string | null }
): ChatReply {
  return {
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
}

function unavailableReply(question: string, error: AgentUnavailableError): ChatReply {
  return {
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
}
