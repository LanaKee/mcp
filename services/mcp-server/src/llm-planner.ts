import type { AgentPlan, AgentPlanStep, Planner, PlannerInput } from "./agent.js";

export interface ChatCompletion {
  complete(prompt: string, signal?: AbortSignal): Promise<string>;
}

export interface LlmPlannerOptions {
  client: ChatCompletion;
  /** Identifies the model in the answer so a route can be attributed. */
  modelName: string;
  /** Planner used when the model is unreachable or returns an unusable plan. */
  fallback?: Planner;
}

/**
 * Prompt given to the model.
 *
 * The model is shown only what {@link searchDatasets} returned and is told to
 * choose from it. It is never given a list of all server tools, so the smallest
 * useful hallucination it can attempt is already outside the candidate set —
 * and `validateStep` refuses that.
 */
export function buildPlannerPrompt(input: PlannerInput): string {
  const catalog = input.candidates.map((candidate) => ({
    datasetId: candidate.datasetId,
    title: candidate.title,
    description: candidate.description,
    grain: candidate.grain,
    evidenceRole: candidate.evidenceRole,
    measures: candidate.measures,
    joinKeys: candidate.joinKeys,
    tools: candidate.tools,
    coverage: {
      available: candidate.coverage.available,
      yearRange: candidate.coverage.yearRange,
      // Named so the model reads the range as "what exists for this region",
      // not "what exists overall".
      regionCoverage: candidate.coverage.regionCoverage,
      regions: candidate.coverage.regions,
      dataStatuses: candidate.coverage.dataStatuses
    }
  }));

  return `당신은 경상북도 공공데이터 질의 계획기입니다.

질문:
${input.question}

아래는 이 질문에 대해 데이터셋 카탈로그가 반환한 후보입니다. 반드시 이 목록
안에서만 선택하십시오.

${JSON.stringify(catalog, null, 2)}

규칙:
1. datasetId와 tool은 위 목록에 있는 조합만 사용합니다. 새로 만들지 마십시오.
2. 각 도구의 requiredArguments를 모두 채웁니다. 질문에서 값을 확보할 수 없으면
   그 도구를 계획에 넣지 말고 unanswerable에 이유를 적습니다.
3. 연도는 해당 데이터셋의 coverage.yearRange 안에서만 지정합니다. coverage.regionCoverage가 있으면 그 yearRange가 해당 지역에 실제로 적재된 연도이므로, 지역별 조회 도구는 그 범위를 따르고 질문이 요구한 구간이 그 밖이면 단계를 만들지 말고 unanswerable에 실제 적재 범위를 적습니다.
4. 지역은 coverage.regions에 있는 이름을 사용합니다.
5. available이 false인 데이터셋은 호출하지 않습니다.
6. 질문에 답하는 데 필요한 최소한의 도구만 호출합니다.
7. 값이나 출처를 직접 지어내지 마십시오. 당신의 역할은 계획뿐이며, 실제 값과
   인용은 도구 실행 결과에서 나옵니다.

다음 JSON만 출력하십시오. 다른 텍스트를 붙이지 마십시오.
{
  "steps": [
    {
      "datasetId": "...",
      "tool": "...",
      "arguments": { },
      "reason": "이 도구를 고른 이유"
    }
  ],
  "unanswerable": null
}`;
}

/**
 * Extracts the JSON object from a model response.
 *
 * Models wrap JSON in prose or fences despite instructions, so this scans for
 * the outermost balanced object rather than trusting the whole body to parse.
 */
export function parsePlanResponse(raw: string): AgentPlan {
  const text = raw.trim().replace(/^```(?:json)?\s*/u, "").replace(/```$/u, "");
  const start = text.indexOf("{");
  if (start === -1) throw new Error("모델 응답에서 JSON 객체를 찾지 못했습니다.");

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) throw new Error("모델 응답의 JSON 객체가 닫히지 않았습니다.");

  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    steps?: unknown;
    unanswerable?: unknown;
  };

  const steps: AgentPlanStep[] = Array.isArray(parsed.steps)
    ? parsed.steps.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const record = entry as Record<string, unknown>;
        if (
          typeof record.datasetId !== "string" ||
          typeof record.tool !== "string"
        ) {
          return [];
        }
        return [
          {
            datasetId: record.datasetId,
            tool: record.tool,
            arguments:
              record.arguments && typeof record.arguments === "object"
                ? (record.arguments as Record<string, unknown>)
                : {},
            reason:
              typeof record.reason === "string" ? record.reason : "모델이 선택함"
          }
        ];
      })
    : [];

  const unanswerable =
    typeof parsed.unanswerable === "string" && parsed.unanswerable.trim()
      ? parsed.unanswerable.trim()
      : null;

  // A plan with neither steps nor a stated reason is not a decision; treat it
  // as a failure so the caller can fall back rather than report a bare refusal.
  if (steps.length === 0 && !unanswerable) {
    throw new Error("모델이 실행 가능한 계획도 거부 사유도 제시하지 않았습니다.");
  }
  return { steps, unanswerable };
}

export class LlmPlanner implements Planner {
  readonly name: string;

  constructor(private readonly options: LlmPlannerOptions) {
    this.name = `llm:${options.modelName}`;
  }

  async plan(input: PlannerInput): Promise<AgentPlan> {
    let plan: AgentPlan;
    try {
      const raw = await this.options.client.complete(buildPlannerPrompt(input));
      plan = parsePlanResponse(raw);
    } catch (caught) {
      if (!this.options.fallback) throw caught;
      // A model outage must not take the demo down. The fallback plans from the
      // same catalog output, so the answer stays sourced either way.
      return this.options.fallback.plan(input);
    }

    // Drop steps aimed at datasets the catalog already reports as empty. The
    // model is told which candidates have no rows but does not reliably obey,
    // and letting the step through only converts a knowable planning error into
    // a runtime refusal.
    const empty = new Set(
      input.candidates
        .filter((candidate) => !candidate.coverage.available)
        .map((candidate) => candidate.datasetId)
    );
    const usable = plan.steps.filter((step) => {
      if (empty.has(step.datasetId)) return false;
      // A required argument present but blank (models like to emit `query: ""`)
      // is not a usable step; treating it as one would send the whole plan to
      // the safety boundary and produce a refusal the fallback could have
      // avoided.
      const binding = input.candidates
        .find((candidate) => candidate.datasetId === step.datasetId)
        ?.tools.find((entry) => entry.tool === step.tool);
      if (!binding) return false;
      return binding.requiredArguments.every((name) => {
        const value = step.arguments[name];
        if (value === undefined || value === null) return false;
        return typeof value !== "string" || value.trim().length > 0;
      });
    });

    // The model may also decline a question the deterministic planner can still
    // route, or aim every step at empty data. Falling back keeps a sourced
    // answer available instead of surfacing an avoidable refusal.
    if (usable.length === 0 && this.options.fallback) {
      const fallbackPlan = await this.options.fallback.plan(input);
      if (fallbackPlan.steps.length > 0) return fallbackPlan;
      return {
        steps: [],
        unanswerable: plan.unanswerable ?? fallbackPlan.unanswerable
      };
    }
    return { ...plan, steps: usable };
  }
}

/**
 * Decides how long to wait before re-sending a rejected request.
 *
 * A rate limit or a gateway blip is a property of the account and the network,
 * not of the model's ability. Recording one as a wrong answer would report the
 * harness's throughput as the model's competence, so a benchmark waits these
 * out. The server does not: it has a deterministic planner to fall back to and
 * stalling a live request for half a minute is worse than answering without the
 * model, so retries are opt-in and default to none.
 */
export function retryDelayMs(
  status: number,
  retryAfter: string | null,
  attempt: number,
  maxRetries = 0
): number | null {
  const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  if (!retryable || attempt >= maxRetries) return null;
  const header = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(header) && header >= 0) return Math.min(header * 1000, 60_000);
  return Math.min(2 ** attempt * 2_000, 32_000);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Detects a provider refusing an explicitly pinned temperature.
 *
 * Reasoning-tuned models reject `temperature` outright instead of clamping it,
 * and the set of models that do so changes with every release. Reading the
 * refusal off the response is more durable than a capability table that silently
 * goes stale, so callers downgrade to the provider default and retry once.
 */
export function rejectsPinnedTemperature(status: number, detail: string): boolean {
  return status === 400 && /temperature/i.test(detail);
}

/** OpenAI-compatible chat completions, which both OpenAI and Grok expose. */
export class OpenAiCompatibleChat implements ChatCompletion {
  /** Set once a request is refused for pinning temperature; never reset. */
  private omitTemperature = false;

  constructor(
    private readonly config: {
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs?: number;
      /** Transient-failure retries; 0 keeps a live request failing fast. */
      maxRetries?: number;
      /** Pinned sampling temperature; `null` sends none at all. */
      temperature?: number | null;
    }
  ) {}

  /** True when this client had to fall back to the provider's default sampling. */
  get usedDefaultTemperature(): boolean {
    return this.omitTemperature || (this.config.temperature ?? 0) === null;
  }

  private requestBody(prompt: string): Record<string, unknown> {
    const temperature = this.config.temperature === undefined ? 0 : this.config.temperature;
    return {
      model: this.config.model,
      messages: [{ role: "user", content: prompt }],
      ...(this.omitTemperature || temperature === null ? {} : { temperature })
    };
  }

  async complete(prompt: string, signal?: AbortSignal, attempt = 0): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 30_000
    );
    if (signal) signal.addEventListener("abort", () => controller.abort());
    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(this.requestBody(prompt)),
        signal: controller.signal
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        if (!this.omitTemperature && rejectsPinnedTemperature(response.status, detail)) {
          this.omitTemperature = true;
          return await this.complete(prompt, signal, attempt);
        }
        const delay = retryDelayMs(
          response.status,
          response.headers.get("retry-after"),
          attempt,
          this.config.maxRetries ?? 0
        );
        if (delay !== null) {
          clearTimeout(timeout);
          await sleep(delay);
          return await this.complete(prompt, signal, attempt + 1);
        }
        throw new Error(
          `LLM 요청이 실패했습니다: ${response.status} ${response.statusText}`
        );
      }
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error("LLM 응답에 내용이 없습니다.");
      return content;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Google Gemini generateContent, which is not OpenAI-shaped. */
export class GeminiChat implements ChatCompletion {
  constructor(
    private readonly config: {
      apiKey: string;
      model: string;
      timeoutMs?: number;
      /** Transient-failure retries; 0 keeps a live request failing fast. */
      maxRetries?: number;
    }
  ) {}

  async complete(prompt: string, signal?: AbortSignal, attempt = 0): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 30_000
    );
    if (signal) signal.addEventListener("abort", () => controller.abort());
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.config.apiKey
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0 }
          }),
          signal: controller.signal
        }
      );
      if (!response.ok) {
        const delay = retryDelayMs(
          response.status,
          response.headers.get("retry-after"),
          attempt,
          this.config.maxRetries ?? 0
        );
        if (delay !== null) {
          clearTimeout(timeout);
          await sleep(delay);
          return await this.complete(prompt, signal, attempt + 1);
        }
        throw new Error(
          `Gemini 요청이 실패했습니다: ${response.status} ${response.statusText}`
        );
      }
      const body = (await response.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string; thought?: boolean }> };
        }>;
      };
      // Thinking-enabled models put reasoning in leading parts flagged
      // `thought`. Taking parts[0] blindly would grade the model's scratchpad
      // instead of its answer, so those are dropped and the rest joined.
      const content = (body.candidates?.[0]?.content?.parts ?? [])
        .filter((part) => part.thought !== true && typeof part.text === "string")
        .map((part) => part.text)
        .join("")
        .trim();
      if (!content) throw new Error("Gemini 응답에 내용이 없습니다.");
      return content;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Anthropic messages API, which is neither OpenAI- nor Gemini-shaped. */
export class AnthropicChat implements ChatCompletion {
  private omitTemperature = false;

  constructor(
    private readonly config: {
      apiKey: string;
      model: string;
      timeoutMs?: number;
      /** Transient-failure retries; 0 keeps a live request failing fast. */
      maxRetries?: number;
      maxTokens?: number;
      temperature?: number | null;
    }
  ) {}

  get usedDefaultTemperature(): boolean {
    return this.omitTemperature || (this.config.temperature ?? 0) === null;
  }

  async complete(prompt: string, signal?: AbortSignal, attempt = 0): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 30_000
    );
    if (signal) signal.addEventListener("abort", () => controller.abort());
    try {
      const temperature =
        this.config.temperature === undefined ? 0 : this.config.temperature;
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: this.config.model,
          // Required by this API, unlike the other two.
          max_tokens: this.config.maxTokens ?? 4096,
          messages: [{ role: "user", content: prompt }],
          ...(this.omitTemperature || temperature === null ? {} : { temperature })
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        if (!this.omitTemperature && rejectsPinnedTemperature(response.status, detail)) {
          this.omitTemperature = true;
          return await this.complete(prompt, signal, attempt);
        }
        const delay = retryDelayMs(
          response.status,
          response.headers.get("retry-after"),
          attempt,
          this.config.maxRetries ?? 0
        );
        if (delay !== null) {
          clearTimeout(timeout);
          await sleep(delay);
          return await this.complete(prompt, signal, attempt + 1);
        }
        throw new Error(
          `Anthropic 요청이 실패했습니다: ${response.status} ${response.statusText}`
        );
      }
      const body = (await response.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      // Extended-thinking responses lead with `thinking` blocks; only `text`
      // blocks are the answer.
      const content = (body.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("")
        .trim();
      if (!content) throw new Error("Anthropic 응답에 내용이 없습니다.");
      return content;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export type ChatProvider = "openai" | "grok" | "gemini" | "anthropic";

/**
 * Infers the provider that serves a model id.
 *
 * Callers name a model, not a vendor, so the routing is derived from the id
 * rather than asking for both and letting them disagree.
 */
export function providerForModel(model: string): ChatProvider | null {
  if (/^(gpt-|o\d|chatgpt-)/u.test(model)) return "openai";
  if (/^claude/u.test(model)) return "anthropic";
  if (/^gemini/u.test(model)) return "gemini";
  if (/^grok/u.test(model)) return "grok";
  return null;
}

/**
 * Builds a client for one explicitly named model.
 *
 * {@link chatClientFromEnv} picks by key precedence, which makes a provider
 * unreachable whenever an earlier key is also set. Comparing models requires
 * addressing each one directly, so this takes the model id as the input.
 */
export function chatClientFor(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    provider?: ChatProvider;
    timeoutMs?: number;
    /** Opt in to waiting out rate limits; batch runs should, servers should not. */
    maxRetries?: number;
  } = {}
): { client: ChatCompletion; modelName: string; provider: ChatProvider } {
  const { provider = null, timeoutMs, maxRetries } = options;
  const resolved = provider ?? providerForModel(model);
  if (resolved === null) {
    throw new Error(
      `모델 '${model}'의 공급자를 알 수 없습니다. gpt-*, claude-*, gemini-*, grok-* 중 하나여야 합니다.`
    );
  }
  const keyByProvider: Record<ChatProvider, string> = {
    openai: "OPENAI_API_KEY",
    grok: "GROK_API_KEY",
    gemini: "GEMINI_API_KEY",
    anthropic: "CLAUDE_API_KEY"
  };
  const apiKey = env[keyByProvider[resolved]];
  if (!apiKey) {
    throw new Error(`${keyByProvider[resolved]}가 필요합니다 (모델 '${model}').`);
  }
  if (resolved === "gemini") {
    return {
      client: new GeminiChat({ apiKey, model, ...(timeoutMs ? { timeoutMs } : {}),
      ...(maxRetries ? { maxRetries } : {}) }),
      modelName: model,
      provider: resolved
    };
  }
  if (resolved === "anthropic") {
    return {
      client: new AnthropicChat({ apiKey, model, ...(timeoutMs ? { timeoutMs } : {}),
      ...(maxRetries ? { maxRetries } : {}) }),
      modelName: model,
      provider: resolved
    };
  }
  return {
    client: new OpenAiCompatibleChat({
      baseUrl: resolved === "grok" ? "https://api.x.ai/v1" : "https://api.openai.com/v1",
      apiKey,
      model,
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(maxRetries ? { maxRetries } : {})
    }),
    modelName: model,
    provider: resolved
  };
}

/**
 * Builds a chat client from whichever API key is configured.
 *
 * Returns null when no key is set so the caller keeps the deterministic
 * planner. The agent must work with no third-party dependency at all.
 */
export function chatClientFromEnv(
  env: NodeJS.ProcessEnv = process.env
): { client: ChatCompletion; modelName: string } | null {
  if (env.OPENAI_API_KEY) {
    const model = env.OPENAI_PLANNER_MODEL ?? "gpt-4o-mini";
    return {
      client: new OpenAiCompatibleChat({
        baseUrl: "https://api.openai.com/v1",
        apiKey: env.OPENAI_API_KEY,
        model
      }),
      modelName: model
    };
  }
  if (env.GROK_API_KEY) {
    const model = env.GROK_PLANNER_MODEL ?? "grok-2-latest";
    return {
      client: new OpenAiCompatibleChat({
        baseUrl: "https://api.x.ai/v1",
        apiKey: env.GROK_API_KEY,
        model
      }),
      modelName: model
    };
  }
  if (env.GEMINI_API_KEY) {
    const model = env.GEMINI_PLANNER_MODEL ?? "gemini-2.0-flash";
    return {
      client: new GeminiChat({ apiKey: env.GEMINI_API_KEY, model }),
      modelName: model
    };
  }
  if (env.CLAUDE_API_KEY) {
    const model = env.CLAUDE_PLANNER_MODEL ?? "claude-sonnet-4-5-20250929";
    return {
      client: new AnthropicChat({ apiKey: env.CLAUDE_API_KEY, model }),
      modelName: model
    };
  }
  return null;
}
