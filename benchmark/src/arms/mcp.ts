/**
 * The grounded arm: the same model, planning over the Gyeongbuk catalog, then
 * answering from the rows its tools actually returned.
 *
 * Two stages, because that is what an MCP client really does. Stage one selects
 * and executes tools behind the agent's safety boundary; stage two hands the
 * retrieved rows back to the model to compose an answer. Reporting only stage
 * one would compare a model against a data dump instead of against the same
 * model with data.
 */

import type { AgentAnswer, Planner } from "../../../services/mcp-server/src/agent.js";
import { runAgent } from "../../../services/mcp-server/src/agent.js";
import type { ChatCompletion } from "../../../services/mcp-server/src/llm-planner.js";
import type { ToolRegistry } from "../../../services/mcp-server/src/tools.js";
import type { ArmResponse } from "../types.js";
import { buildSynthesisPrompt, extractAttributions } from "./prompt.js";

/** Caps the evidence payload so a wide result set cannot overrun the context. */
const MAX_EVIDENCE_CHARS = 12_000;

/** Serialises the retrieved rows for the synthesis prompt. */
export function renderEvidence(answer: AgentAnswer): string {
  if (answer.evidence.length === 0) return "(조회된 자료 없음)";
  return answer.evidence
    .map((item) => {
      const payload = JSON.stringify(item.detail ?? null);
      return [
        `## ${item.statement}`,
        `도구: ${item.tool} / 데이터셋: ${item.datasetId} / 상태: ${item.dataStatus}`,
        payload.length > MAX_EVIDENCE_CHARS
          ? `${payload.slice(0, MAX_EVIDENCE_CHARS)}… (이하 생략)`
          : payload
      ].join("\n");
    })
    .join("\n\n");
}

/** Full structured record of what the agent did, kept for auditing. */
export function renderTranscript(answer: AgentAnswer, finalAnswer: string): string {
  const parts: string[] = [
    `[최종 답변]\n${finalAnswer}`,
    `\n[에이전트 결론]\n${answer.conclusion}`
  ];
  if (answer.plan.length > 0) {
    parts.push(
      "\n[실행 계획]\n" +
        answer.plan.map((step) => `- ${step.datasetId}/${step.tool}: ${step.reason}`).join("\n")
    );
  }
  if (answer.evidence.length > 0) parts.push(`\n[조회 결과]\n${renderEvidence(answer)}`);
  if (answer.sources.length > 0) {
    parts.push(
      "\n[출처]\n" +
        answer.sources
          .map(
            (source) =>
              `- ${source.title} · ${source.provider} · 수집 ${source.collectedAt} · source_id=${source.sourceId}`
          )
          .join("\n")
    );
  }
  if (answer.limitations.length > 0) {
    parts.push("\n[한계]\n" + answer.limitations.map((note) => `- ${note}`).join("\n"));
  }
  if (answer.rejectedSteps.length > 0) {
    parts.push(
      "\n[거부된 단계]\n" +
        answer.rejectedSteps.map((entry) => `- ${entry.step.tool}: ${entry.reason}`).join("\n")
    );
  }
  return parts.join("\n");
}

export async function runMcpArm(
  registry: ToolRegistry,
  planner: Planner,
  client: ChatCompletion,
  question: string
): Promise<ArmResponse> {
  const startedAt = Date.now();
  try {
    const answer = await runAgent(registry, question, planner);

    // With no evidence there is nothing to synthesise from, and prompting the
    // model anyway would invite it to fill the gap from memory — the precise
    // failure the grounding exists to prevent.
    const finalAnswer =
      answer.evidence.length === 0
        ? answer.conclusion
        : await client.complete(buildSynthesisPrompt(question, renderEvidence(answer)));

    const sourceIds = [...new Set(answer.sources.map((source) => source.sourceId))];
    return {
      arm: "mcp",
      text: finalAnswer,
      transcript: renderTranscript(answer, finalAnswer),
      // Taken from the agent's structured output rather than parsed out of the
      // prose, so a citation counts only when a tool really produced it.
      citedSourceIds: answer.evidence.length === 0 ? [] : sourceIds,
      citedAttributions: extractAttributions(finalAnswer),
      declined: answer.evidence.length === 0 && !answer.answered,
      latencyMs: Date.now() - startedAt,
      error: null
    };
  } catch (caught) {
    return {
      arm: "mcp",
      text: "",
      transcript: "",
      citedSourceIds: [],
      citedAttributions: [],
      declined: null,
      latencyMs: Date.now() - startedAt,
      error: (caught as Error).message
    };
  }
}
