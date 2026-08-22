/**
 * Evaluation for this project lives entirely in `benchmark.ts`.
 *
 * An earlier `evaluateToolResult` asked only "did the expected tool run, with
 * the expected status and source ids". Its case file (`evals/questions.jsonl`)
 * still expected `demo_sample` and `demo-*` source ids long after operations
 * moved to `official_observed` only, so it asserted behaviour the server no
 * longer had and no runner read it. A green-looking check that contradicts the
 * README is worse than no check, so both were removed rather than updated:
 * `evals/benchmark.jsonl` already covers the same questions against the loaded
 * official data and scores them on eleven metrics instead of three equalities.
 */
export * from "./benchmark.js";
