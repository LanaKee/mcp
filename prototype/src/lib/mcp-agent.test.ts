import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentUnavailableError } from "./agent";
import { askViaMcp } from "./mcp-agent";

/** Responses 스트림 한 프레임. 실제 서버가 보내는 모양 그대로다. */
function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function streamOf(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of frames) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  return new Response(body, { status: 200 });
}

function mcpCall(name: string, args: unknown, output: unknown, error: unknown = null) {
  return {
    type: "response.output_item.done",
    item: {
      type: "mcp_call",
      name,
      arguments: JSON.stringify(args),
      output: output === null ? null : JSON.stringify(output),
      error
    }
  };
}

const POPULATION_OUTPUT = {
  data_status: "official_observed",
  result: {
    region: "봉화군",
    unit: "명",
    points: [
      { year: 2017, value: 33561, sourceId: "official:aaa" },
      { year: 2024, value: 28836, sourceId: "official:bbb" }
    ]
  }
};

function install(response: Response | Error) {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("PLANNER_MODEL", "stub-model");
  vi.stubEnv("MCP_SERVER_URL", "https://example.test/mcp");
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("askViaMcp", () => {
  it("모델이 실제로 부른 호출과 그 결과를 근거로 옮긴다", async () => {
    install(
      streamOf([
        frame({ type: "response.created" }),
        frame(
          mcpCall(
            "get_population_trend",
            { region: "봉화군", startYear: 2017, endYear: 2024 },
            POPULATION_OUTPUT
          )
        ),
        frame({ type: "response.output_text.delta", delta: "봉화군 인구는 " }),
        frame({ type: "response.output_text.delta", delta: "감소했습니다." }),
        frame({ type: "response.completed" })
      ])
    );

    const answer = await askViaMcp("봉화군 인구는 어떻게 변했나?");

    expect(answer.answered).toBe(true);
    expect(answer.planner).toBe("mcp:stub-model");
    expect(answer.plan).toHaveLength(1);
    expect(answer.plan[0]!.tool).toBe("get_population_trend");
    expect(answer.plan[0]!.arguments).toMatchObject({ region: "봉화군" });
    expect(answer.conclusion).toBe("봉화군 인구는 감소했습니다.");
    expect(answer.evidence[0]!.dataStatus).toBe("official_observed");
  });

  it("결과 어디에 박혀 있든 출처 식별자를 모은다", async () => {
    // 출처 없는 문장은 이 프로젝트에서 쓸 수 없으므로, 도구마다 다른 결과
    // 모양을 가정하지 않고 전부 훑어야 한다.
    install(
      streamOf([
        frame(mcpCall("get_population_trend", {}, POPULATION_OUTPUT)),
        frame({ type: "response.output_text.delta", delta: "확인했습니다." }),
        frame({ type: "response.completed" })
      ])
    );

    const answer = await askViaMcp("봉화군 인구");

    expect(answer.evidence[0]!.sourceIds.sort()).toEqual(["official:aaa", "official:bbb"]);
    expect(answer.sources.map((source) => source.sourceId).sort()).toEqual([
      "official:aaa",
      "official:bbb"
    ]);
  });

  it("도구를 한 번도 성공시키지 못하면 결론이 있어도 답했다고 하지 않는다", async () => {
    // 근거 없이 남은 글은 모델이 기억에서 쓴 문장이다. 이 프로젝트에서 그것을
    // 답으로 통과시키는 것이 가장 큰 실패다.
    install(
      streamOf([
        frame(mcpCall("get_population_trend", {}, null, { message: "timeout" })),
        frame({ type: "response.output_text.delta", delta: "대략 3만 명입니다." }),
        frame({ type: "response.completed" })
      ])
    );

    const answer = await askViaMcp("봉화군 인구");

    expect(answer.answered).toBe(false);
    expect(answer.evidence).toHaveLength(0);
    expect(answer.rejectedSteps).toHaveLength(1);
    expect(answer.rejectedSteps[0]!.reason).toContain("timeout");
  });

  it("search_datasets 결과를 후보 목록으로 옮긴다", async () => {
    install(
      streamOf([
        frame(
          mcpCall(
            "search_datasets",
            { query: "봉화군 인구" },
            {
              data_status: "official_observed",
              result: {
                datasets: [
                  {
                    datasetId: "population_observation",
                    title: "시군별 인구 관측",
                    matchedTerms: ["인구"],
                    coverage: { available: true }
                  }
                ]
              }
            }
          )
        ),
        frame({ type: "response.output_text.delta", delta: "찾았습니다." }),
        frame({ type: "response.completed" })
      ])
    );

    const answer = await askViaMcp("봉화군 인구");

    expect(answer.consideredDatasets).toEqual([
      {
        datasetId: "population_observation",
        title: "시군별 인구 관측",
        matchedTerms: ["인구"],
        available: true
      }
    ]);
  });

  it("카탈로그를 건너뛰어도 근거는 남긴다", async () => {
    // 모델이 search_datasets 없이 곧장 도구를 부르는 일이 흔하다. 그때 후보
    // 목록이 비었다고 해서 답을 못 했다고 기록하면 화면이 거짓을 말한다.
    install(
      streamOf([
        frame(mcpCall("search_policies", { region: "상주시", age: 34 }, POPULATION_OUTPUT)),
        frame({ type: "response.output_text.delta", delta: "확인했습니다." }),
        frame({ type: "response.completed" })
      ])
    );

    const answer = await askViaMcp("스마트팜 창업 준비");

    expect(answer.consideredDatasets).toHaveLength(0);
    expect(answer.plan).toHaveLength(1);
    expect(answer.answered).toBe(true);
    expect(answer.evidence).toHaveLength(1);
  });

  it("호출과 추론 요약을 일어나는 대로 흘려보낸다", async () => {
    install(
      streamOf([
        frame({ type: "response.reasoning_summary_text.delta", delta: "인구 도구를 " }),
        frame({ type: "response.reasoning_summary_text.delta", delta: "고르는 중" }),
        frame(mcpCall("get_population_trend", { region: "봉화군" }, POPULATION_OUTPUT)),
        frame({ type: "response.completed" })
      ])
    );

    const reasoning: string[] = [];
    const calls: string[] = [];
    const results: Array<{ ok: boolean; sourceCount: number }> = [];
    await askViaMcp("봉화군 인구", {
      onReasoning: (delta) => reasoning.push(delta),
      onToolCall: (call) => calls.push(call.tool),
      onToolResult: (result) => results.push({ ok: result.ok, sourceCount: result.sourceCount })
    });

    expect(reasoning.join("")).toBe("인구 도구를 고르는 중");
    expect(calls).toEqual(["get_population_trend"]);
    expect(results).toEqual([{ ok: true, sourceCount: 2 }]);
  });

  it("프레임이 청크 경계에서 잘려도 이어 붙인다", async () => {
    // SSE 청크는 이벤트 경계와 무관하게 끊긴다. 잘린 꼬리를 버리면 도구 호출
    // 하나가 통째로 사라지고, 화면은 근거가 없다고 잘못 말한다.
    const whole = frame(mcpCall("get_population_trend", {}, POPULATION_OUTPUT));
    const cut = Math.floor(whole.length / 2);
    install(
      streamOf([
        whole.slice(0, cut),
        whole.slice(cut),
        frame({ type: "response.output_text.delta", delta: "확인" }),
        frame({ type: "response.completed" })
      ])
    );

    const answer = await askViaMcp("봉화군 인구");

    expect(answer.plan).toHaveLength(1);
    expect(answer.evidence).toHaveLength(1);
  });

  it("자격 증명이 없으면 답을 지어내지 않고 연결 실패로 올린다", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("OPENAI_API_KEY", "");

    await expect(askViaMcp("봉화군 인구")).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  it("모델이 요청을 거절하면 연결 실패로 올린다", async () => {
    install(new Response("nope", { status: 500, statusText: "Server Error" }));

    await expect(askViaMcp("봉화군 인구")).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  it("MCP 서버 주소와 승인 정책을 요청에 그대로 싣는다", async () => {
    const fetchMock = install(
      streamOf([
        frame(mcpCall("get_population_trend", {}, POPULATION_OUTPUT)),
        frame({ type: "response.completed" })
      ])
    );

    await askViaMcp("봉화군 인구");

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      tools: Array<{ type: string; server_url: string; require_approval: string }>;
      stream: boolean;
    };
    expect(body.stream).toBe(true);
    expect(body.tools[0]).toMatchObject({
      type: "mcp",
      server_url: "https://example.test/mcp",
      require_approval: "never"
    });
  });
});
