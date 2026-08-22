/**
 * The ungrounded arm: the same model, answering from parametric memory alone.
 *
 * This is the honest baseline for "why not just ask a general model?", which is
 * the question the whole project has to answer.
 */

import type { ChatCompletion } from "../../../services/mcp-server/src/llm-planner.js";
import type { ArmResponse } from "../types.js";
import { buildVanillaPrompt, extractAttributions, extractSourceIds } from "./prompt.js";

export async function runVanillaArm(
  client: ChatCompletion,
  question: string
): Promise<ArmResponse> {
  const startedAt = Date.now();
  try {
    const text = await client.complete(buildVanillaPrompt(question));
    return {
      arm: "vanilla",
      text,
      transcript: text,
      citedSourceIds: extractSourceIds(text),
      citedAttributions: extractAttributions(text),
      declined: null,
      latencyMs: Date.now() - startedAt,
      error: null
    };
  } catch (caught) {
    return {
      arm: "vanilla",
      text: "",
      transcript: "",
      citedSourceIds: [],
      citedAttributions: [],
      declined: null,
      latencyMs: Date.now() - startedAt,
      // Recorded rather than thrown: one transport failure should not discard
      // the other 21 cases, and a failure is not a refusal.
      error: (caught as Error).message
    };
  }
}
