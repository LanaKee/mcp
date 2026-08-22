import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadDemoData } from "./data-store.js";
import { InMemoryDataRepository } from "./repository.js";
import { createToolRegistry, type ToolRegistry } from "./tools.js";
import { runAgent, validateStep } from "./agent.js";
import { HeuristicPlanner } from "./planner.js";
import { searchDatasets } from "./catalog-tools.js";
import {
  buildPlannerPrompt,
  chatClientFromEnv,
  LlmPlanner,
  parsePlanResponse,
  type ChatCompletion
} from "./llm-planner.js";

const stubChat = (reply: string | Error): ChatCompletion => ({
  complete: async () => {
    if (reply instanceof Error) throw reply;
    return reply;
  }
});

describe("plan response parsing", () => {
  it("parses a bare JSON plan", () => {
    const plan = parsePlanResponse(
      '{"steps":[{"datasetId":"population_observation","tool":"get_population_trend","arguments":{"region":"포항시"},"reason":"인구 질문"}],"unanswerable":null}'
    );
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.arguments).toEqual({ region: "포항시" });
    expect(plan.unanswerable).toBeNull();
  });

  it("parses JSON wrapped in a code fence", () => {
    const plan = parsePlanResponse(
      '```json\n{"steps":[],"unanswerable":"연도가 없습니다"}\n```'
    );
    expect(plan.unanswerable).toBe("연도가 없습니다");
  });

  it("parses JSON surrounded by prose", () => {
    // Models add commentary despite instructions; the parser scans for the
    // outermost balanced object instead of trusting the whole body.
    const plan = parsePlanResponse(
      '계획은 다음과 같습니다.\n{"steps":[],"unanswerable":"지역 없음"}\n이상입니다.'
    );
    expect(plan.unanswerable).toBe("지역 없음");
  });

  it("is not confused by braces inside strings", () => {
    const plan = parsePlanResponse(
      '{"steps":[],"unanswerable":"중괄호 } 가 들어간 사유"}'
    );
    expect(plan.unanswerable).toBe("중괄호 } 가 들어간 사유");
  });

  it("drops malformed steps instead of passing them through", () => {
    const plan = parsePlanResponse(
      '{"steps":[{"tool":"get_population_trend"},{"datasetId":"population_observation","tool":"get_population_trend","arguments":{},"reason":"ok"}],"unanswerable":null}'
    );
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.datasetId).toBe("population_observation");
  });

  it("rejects a response with neither steps nor a stated reason", () => {
    // An empty plan without a reason is not a decision the agent can report.
    expect(() => parsePlanResponse('{"steps":[],"unanswerable":null}')).toThrow(
      /계획도 거부 사유도/u
    );
    expect(() => parsePlanResponse("완전히 관계없는 텍스트")).toThrow(
      /JSON 객체를 찾지 못했습니다/u
    );
  });
});

describe("planner prompt", () => {
  let registry: ToolRegistry;

  beforeAll(async () => {
    registry = createToolRegistry(
      new InMemoryDataRepository(await loadDemoData())
    );
  });

  it("shows the model only the catalog candidates and their real coverage", async () => {
    const candidates = (
      await searchDatasets(registry.repository, { query: "인구", limit: 3 })
    ).hits;
    const prompt = buildPlannerPrompt({ question: "포항시 인구는?", candidates });
    expect(prompt).toContain("population_observation");
    expect(prompt).toContain("get_population_trend");
    // The model must never be handed the full server tool list.
    expect(prompt).not.toContain("draft_public_document");
    expect(prompt).toContain("coverage");
    expect(prompt).toContain("지어내지 마십시오");
  });
});

describe("LLM planner integration with the agent", () => {
  let registry: ToolRegistry;

  beforeAll(async () => {
    registry = createToolRegistry(
      new InMemoryDataRepository(await loadDemoData())
    );
  });

  it("executes a valid model plan and cites the resulting sources", async () => {
    const answer = await runAgent(
      registry,
      "포항시 인구 2020년부터 2024년까지",
      new LlmPlanner({
        modelName: "stub",
        client: stubChat(
          JSON.stringify({
            steps: [
              {
                datasetId: "population_observation",
                tool: "get_population_trend",
                arguments: {
                  region: "포항시",
                  startYear: 2020,
                  endYear: 2024,
                  dataStatuses: ["demo_sample"]
                },
                reason: "인구 시계열 질문"
              }
            ],
            unanswerable: null
          })
        )
      })
    );
    expect(answer.answered).toBe(true);
    expect(answer.planner).toBe("llm:stub");
    expect(answer.evidence[0]!.sourceIds.length).toBeGreaterThan(0);
  });

  it("refuses a model plan naming a tool outside the candidate set", async () => {
    const answer = await runAgent(
      registry,
      "포항시 인구 2020년부터 2024년까지",
      new LlmPlanner({
        modelName: "stub",
        client: stubChat(
          JSON.stringify({
            steps: [
              {
                datasetId: "population_observation",
                tool: "drop_all_tables",
                arguments: { region: "포항시" },
                reason: "환각"
              }
            ],
            unanswerable: null
          })
        )
      })
    );
    // With no fallback configured a hallucinated tool leaves nothing runnable,
    // so the agent declines. The point is that it never executes and never
    // fabricates; whether the step is dropped by the planner's own usability
    // filter or by validateStep, no unsourced answer can escape.
    expect(answer.answered).toBe(false);
    expect(answer.evidence).toHaveLength(0);
    expect(answer.sources).toHaveLength(0);
  });

  it("still routes a hallucinated tool to the safety boundary when it slips past the planner", async () => {
    // validateStep is the last line of defence and is tested directly, because
    // the planner-level filter is an optimisation, not the guarantee.
    const candidates = (
      await searchDatasets(registry.repository, {
        query: "포항시 인구",
        limit: 5
      })
    ).hits;
    const reason = validateStep(
      {
        datasetId: "population_observation",
        tool: "drop_all_tables",
        arguments: { region: "포항시" },
        reason: "환각"
      },
      candidates,
      registry
    );
    expect(reason).toContain("도구가 아닙니다");
  });

  it("rejects a blank required argument the tool's own schema would refuse", async () => {
    // Observed with a real model: it emitted `query: ""`, which satisfies
    // "argument present" but fails the schema's min-length. The boundary now
    // validates with the tool's own parser so this can never reach execution.
    const candidates = (
      await searchDatasets(registry.repository, {
        query: "의안 발의",
        limit: 5
      })
    ).hits;
    const billCandidate = candidates.find(
      (hit) => hit.datasetId === "council_bill"
    );
    expect(billCandidate).toBeDefined();
    const reason = validateStep(
      {
        datasetId: "council_bill",
        tool: "search_member_bills",
        arguments: { query: "" },
        reason: "빈 질의"
      },
      candidates,
      registry
    );
    expect(reason).not.toBeNull();
  });

  it("falls back to the deterministic planner when the model is unreachable", async () => {
    // A model outage must degrade the route, not the answer's sourcing.
    const answer = await runAgent(
      registry,
      "포항시 인구 2020년부터 2024년까지",
      new LlmPlanner({
        modelName: "stub",
        client: stubChat(new Error("network down")),
        fallback: new HeuristicPlanner()
      })
    );
    expect(answer.answered).toBe(true);
    expect(answer.evidence[0]!.tool).toBe("get_population_trend");
  });

  it("propagates the model's refusal when it says the question is unanswerable", async () => {
    const answer = await runAgent(
      registry,
      "포항시 인구 2020년부터 2024년까지",
      new LlmPlanner({
        modelName: "stub",
        client: stubChat('{"steps":[],"unanswerable":"연도 범위가 커버리지 밖입니다"}')
      })
    );
    expect(answer.answered).toBe(false);
    expect(answer.conclusion).toContain("커버리지 밖");
  });
});

describe("chat client selection", () => {
  it("returns null when no provider key is configured", () => {
    expect(chatClientFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("selects a provider from whichever key is present", () => {
    expect(
      chatClientFromEnv({ GEMINI_API_KEY: "k" } as NodeJS.ProcessEnv)?.modelName
    ).toContain("gemini");
    expect(
      chatClientFromEnv({ GROK_API_KEY: "k" } as NodeJS.ProcessEnv)?.modelName
    ).toContain("grok");
  });

  it("honours an explicit model override", () => {
    expect(
      chatClientFromEnv({
        OPENAI_API_KEY: "k",
        OPENAI_PLANNER_MODEL: "gpt-4.1"
      } as NodeJS.ProcessEnv)?.modelName
    ).toBe("gpt-4.1");
  });
});

describe("LLM request shape", () => {
  it("sends a deterministic, bounded request and reads the reply", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "{\"steps\":[],\"unanswerable\":\"x\"}" } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { OpenAiCompatibleChat } = await import("./llm-planner.js");
      const chat = new OpenAiCompatibleChat({
        baseUrl: "https://example.test/v1",
        apiKey: "secret",
        model: "test-model"
      });
      const reply = await chat.complete("prompt");
      expect(reply).toContain("unanswerable");
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://example.test/v1/chat/completions");
      const body = JSON.parse(init.body as string) as { temperature: number };
      // Planning must be reproducible for the benchmark to mean anything.
      expect(body.temperature).toBe(0);
      expect(init.signal).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("surfaces a provider error instead of returning an empty plan", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 429, statusText: "Too Many Requests" }))
    );
    try {
      const { OpenAiCompatibleChat } = await import("./llm-planner.js");
      const chat = new OpenAiCompatibleChat({
        baseUrl: "https://example.test/v1",
        apiKey: "secret",
        model: "test-model"
      });
      // No retry budget by default: a live request must fall through to the
      // deterministic planner rather than stall while a rate limit clears.
      await expect(chat.complete("prompt")).rejects.toThrow(/429/u);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("explicit model selection", () => {
  it("routes a model id to the provider that serves it", async () => {
    const { providerForModel } = await import("./llm-planner.js");
    expect(providerForModel("gpt-5.6-luna")).toBe("openai");
    expect(providerForModel("o3-mini")).toBe("openai");
    expect(providerForModel("claude-sonnet-5")).toBe("anthropic");
    expect(providerForModel("gemini-3.6-flash")).toBe("gemini");
    expect(providerForModel("grok-2-latest")).toBe("grok");
    expect(providerForModel("llama-3")).toBeNull();
  });

  it("reaches a provider that key precedence would otherwise hide", async () => {
    const { chatClientFor } = await import("./llm-planner.js");
    // chatClientFromEnv would return OpenAI here; comparing models requires
    // addressing Gemini directly despite the earlier key being set.
    const selected = chatClientFor("gemini-3.6-flash", {
      OPENAI_API_KEY: "k",
      GEMINI_API_KEY: "g"
    } as NodeJS.ProcessEnv);
    expect(selected.provider).toBe("gemini");
    expect(selected.modelName).toBe("gemini-3.6-flash");
  });

  it("names the missing key rather than falling back silently", async () => {
    const { chatClientFor } = await import("./llm-planner.js");
    expect(() =>
      chatClientFor("claude-sonnet-5", { OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv)
    ).toThrow(/CLAUDE_API_KEY/u);
  });

  it("refuses an unroutable model instead of guessing a provider", async () => {
    const { chatClientFor } = await import("./llm-planner.js");
    expect(() => chatClientFor("mystery-1", {} as NodeJS.ProcessEnv)).toThrow(/공급자/u);
  });
});

describe("temperature capability fallback", () => {
  it("retries without temperature when the model refuses a pinned value", async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            error: { message: "Unsupported value: 'temperature' does not support 0" }
          }),
          { status: 400, statusText: "Bad Request" }
        );
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { OpenAiCompatibleChat } = await import("./llm-planner.js");
      const chat = new OpenAiCompatibleChat({
        baseUrl: "https://example.test/v1",
        apiKey: "secret",
        model: "reasoning-model"
      });
      expect(await chat.complete("prompt")).toBe("ok");
      expect(JSON.parse(bodies[0] as string)).toHaveProperty("temperature", 0);
      // The retry must drop the key entirely, not send a different value.
      expect(JSON.parse(bodies[1] as string)).not.toHaveProperty("temperature");
      // The run is no longer reproducible, and the report has to say so.
      expect(chat.usedDefaultTemperature).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not retry a 400 that has nothing to do with temperature", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "context length exceeded" } }), {
          status: 400,
          statusText: "Bad Request"
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { OpenAiCompatibleChat } = await import("./llm-planner.js");
      const chat = new OpenAiCompatibleChat({
        baseUrl: "https://example.test/v1",
        apiKey: "secret",
        model: "test-model"
      });
      await expect(chat.complete("prompt")).rejects.toThrow(/400/u);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("provider response shapes", () => {
  it("sends the max_tokens Anthropic requires and reads only text blocks", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: [
              { type: "thinking", thinking: "내부 추론" },
              { type: "text", text: "답변" }
            ]
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { AnthropicChat } = await import("./llm-planner.js");
      const chat = new AnthropicChat({ apiKey: "secret", model: "claude-sonnet-5" });
      // Grading the scratchpad instead of the answer would silently corrupt
      // every score for this provider.
      expect(await chat.complete("prompt")).toBe("답변");
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toHaveProperty("max_tokens");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("drops Gemini thought parts instead of returning the first part", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      { text: "내부 추론", thought: true },
                      { text: "실제 답변" }
                    ]
                  }
                }
              ]
            }),
            { status: 200 }
          )
      )
    );
    try {
      const { GeminiChat } = await import("./llm-planner.js");
      const chat = new GeminiChat({ apiKey: "secret", model: "gemini-3.6-flash" });
      expect(await chat.complete("prompt")).toBe("실제 답변");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("transient failure handling", () => {
  it("waits out a rate limit instead of reporting it as a model failure", async () => {
    const { retryDelayMs } = await import("./llm-planner.js");
    // A 429 says the account ran out of quota, not that the model was wrong.
    expect(retryDelayMs(429, null, 0, 4)).toBeGreaterThan(0);
    expect(retryDelayMs(503, null, 0, 4)).toBeGreaterThan(0);
    // An explicit Retry-After beats the backoff guess.
    expect(retryDelayMs(429, "7", 0, 4)).toBe(7_000);
    // A bad request will fail again no matter how long we wait.
    expect(retryDelayMs(400, null, 0, 4)).toBeNull();
    expect(retryDelayMs(401, null, 0, 4)).toBeNull();
    // Retries are bounded so a sustained outage cannot hang the run.
    expect(retryDelayMs(429, null, 4, 4)).toBeNull();
    // Default is no retry budget at all, which is what the server wants.
    expect(retryDelayMs(429, null, 0)).toBeNull();
  });

  it("retries a rate-limited call and returns the eventual answer", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("rate limited", {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "retry-after": "0" }
          });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200
        });
      })
    );
    try {
      const { OpenAiCompatibleChat } = await import("./llm-planner.js");
      const chat = new OpenAiCompatibleChat({
        baseUrl: "https://example.test/v1",
        apiKey: "secret",
        model: "test-model",
        maxRetries: 4
      });
      expect(await chat.complete("prompt")).toBe("ok");
      expect(calls).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
