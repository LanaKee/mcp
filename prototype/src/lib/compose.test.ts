import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAnswer } from "./agent";
import { composeView } from "./compose";

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
