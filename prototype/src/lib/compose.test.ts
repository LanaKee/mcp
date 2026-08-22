import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAnswer } from "./agent";
import { composeView, composeViewStream } from "./compose";

const baseAnswer: AgentAnswer = {
  question: "포항시 인구 추세",
  planner: "heuristic",
  consideredDatasets: [
    { datasetId: "population_observation", title: "시군별 인구 관측", matchedTerms: ["인구"], available: true }
  ],
  plan: [],
  answered: true,
  conclusion: "시군별 인구 관측에서 근거를 수집했습니다.",
  evidence: [
    {
      statement: "인구 추세",
      datasetId: "population_observation",
      tool: "get_population_trend",
      dataStatus: "official_observed",
      sourceIds: ["official:a"],
      detail: {
        region: "포항시",
        unit: "명",
        points: [
          { year: 2020, value: 508791 },
          { year: 2024, value: 499352 }
        ]
      }
    }
  ],
  joins: [],
  sources: [],
  limitations: [],
  rejectedSteps: [],
  unavailableDatasets: []
};

function anthropicResponse(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("composeView", () => {
  it("모델이 낸 블록을 그대로 화면 뷰로 쓴다", async () => {
    vi.stubEnv("CLAUDE_API_KEY", "test-key");
    vi.stubEnv("PROTOTYPE_MODEL", "claude-sonnet-5");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        anthropicResponse(
          '```json\n{"summary":"포항시 인구가 줄었습니다","blocks":[{"kind":"callout","tone":"info","text":"관측값입니다"}]}\n```'
        )
      )
    );

    const result = await composeView(baseAnswer);

    expect(result.degraded).toBeNull();
    expect(result.composer).toBe("claude-sonnet-5");
    expect(result.view.blocks[0]?.kind).toBe("callout");
  });

  it("모델 호출이 실패해도 근거로 화면을 그린다", async () => {
    vi.stubEnv("CLAUDE_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream down", { status: 503 }))
    );

    const result = await composeView(baseAnswer);

    expect(result.composer).toBe("deterministic");
    expect(result.degraded).toContain("503");
    expect(result.view.blocks.some((block) => block.kind === "series")).toBe(true);
  });

  it("JSON이 아닌 줄글 응답은 채택하지 않는다", async () => {
    vi.stubEnv("CLAUDE_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => anthropicResponse("포항시 인구는 계속 줄고 있습니다. 자세히 설명드리면..."))
    );

    const result = await composeView(baseAnswer);

    expect(result.composer).toBe("deterministic");
    expect(result.degraded).toContain("호출 실패");
  });

  it("근거 요약에는 도구 응답 값이 들어간다", async () => {
    vi.stubEnv("CLAUDE_API_KEY", "test-key");
    const fetchMock = vi.fn(
      async (_input: unknown, _init?: { body?: string }): Promise<Response> =>
        anthropicResponse('{"summary":"요약","blocks":[{"kind":"callout","tone":"info","text":"확인"}]}')
    );
    vi.stubGlobal("fetch", fetchMock);

    await composeView(baseAnswer);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    const prompt = body.messages[0]?.content ?? "";
    expect(prompt).toContain("508791");
    expect(prompt).toContain("근거에 없는 수치");
  });
});

/** Claude 스트리밍 SSE 응답. 텍스트를 조각내 흘려보낸다. */
function anthropicStream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        const frame = {
          type: "content_block_delta",
          delta: { type: "text_delta", text: chunk }
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("composeViewStream", () => {
  it("응답 끝이 깨져도 스트리밍 중 닫힌 카드는 버리지 않는다", async () => {
    // 긴 응답에서 모델이 마지막 괄호를 흘리면 전체 파싱이 무너진다. 그때마다
    // 결정적 렌더러로 내려가면 이미 검증을 통과해 화면에 그려진 카드를 지우고
    // 훨씬 빈약한 화면으로 되돌아가게 된다.
    vi.stubEnv("CLAUDE_API_KEY", "test-key");
    vi.stubEnv("PROTOTYPE_MODEL", "claude-sonnet-5");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        anthropicStream([
          '{"summary":"포항시 인구가 줄었습니다","blocks":[',
          '{"kind":"callout","tone":"info","text":"관측값입니다"},',
          '{"kind":"headline","title":"인구 감소","subtitle":"2020-2024"}',
          // 닫는 괄호가 오지 않는다.
          ','
        ])
      )
    );

    const blocks: string[] = [];
    const result = await composeViewStream(baseAnswer, {
      onBlock: (block) => blocks.push(block.kind)
    });

    expect(blocks).toEqual(["callout", "headline"]);
    expect(result.composer).toBe("claude-sonnet-5");
    expect(result.view.blocks.map((block) => block.kind)).toEqual(["callout", "headline"]);
    expect(result.degraded).toContain("스트리밍 중 완성된 카드 2장");
  });

  it("토큰 상한에 걸린 것을 파싱 오류로 둘러대지 않는다", async () => {
    // "Expected ',' or ']'"만 남으면 모델이 이상한 JSON을 냈다고 오해하게 된다.
    // 실제 원인은 응답이 상한에서 잘린 것이고, 고칠 곳도 전혀 다르다.
    vi.stubEnv("CLAUDE_API_KEY", "test-key");
    vi.stubEnv("PROTOTYPE_MODEL", "claude-sonnet-5");
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const push = (event: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        for (const text of [
          '{"summary":"포항시 인구가 줄었습니다","blocks":[',
          '{"kind":"callout","tone":"info","text":"관측값입니다"},'
        ]) {
          push({ type: "content_block_delta", delta: { type: "text_delta", text } });
        }
        push({ type: "message_delta", delta: { stop_reason: "max_tokens" } });
        controller.close();
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 }))
    );

    const result = await composeViewStream(baseAnswer);

    expect(result.composer).toBe("claude-sonnet-5");
    expect(result.degraded).toContain("출력 토큰 상한");
  });

  it("닫힌 카드가 하나도 없으면 근거로 화면을 그린다", async () => {
    vi.stubEnv("CLAUDE_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async () => anthropicStream(['{"summary":"요약","blocks":[{"kind"'])));

    const result = await composeViewStream(baseAnswer);

    expect(result.composer).toBe("deterministic");
    expect(result.view.blocks.some((block) => block.kind === "series")).toBe(true);
  });
});
