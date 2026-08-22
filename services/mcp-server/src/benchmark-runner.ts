import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseBenchmarkCases,
  scoreBenchmarkCase,
  summarizeBenchmark,
  type BenchmarkCaseResult,
  type BenchmarkReport
} from "@gb/evaluation";
import { runAgent, type Planner } from "./agent.js";
import { chatClientFromEnv, LlmPlanner } from "./llm-planner.js";
import { HeuristicPlanner } from "./planner.js";
import { createDataRepository, loadRepositoryEnvironment } from "./runtime.js";
import { createToolRegistry } from "./tools.js";

/**
 * Runs every benchmark question through the real agent against the real
 * repository, so the numbers describe the deployed system rather than a mock.
 *
 * `--planner heuristic` forces the deterministic planner. Running both planners
 * matters: it separates "the catalog surfaced the wrong dataset" from "the model
 * chose badly", which a single blended score would hide.
 */

// Resolved from the module rather than cwd, because pnpm --filter runs this
// with the package directory as cwd while the evals live at the repo root.
const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

interface RunnerOptions {
  planner: "auto" | "heuristic" | "llm";
  out?: string;
}

export function parseArgs(argv: string[]): RunnerOptions {
  const options: RunnerOptions = { planner: "auto" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--planner") {
      const value = argv[index + 1];
      if (value === "heuristic" || value === "llm" || value === "auto") {
        options.planner = value;
      }
      index += 1;
    } else if (arg === "--out") {
      options.out = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

function selectPlanner(mode: RunnerOptions["planner"]): Planner {
  const heuristic = new HeuristicPlanner();
  if (mode === "heuristic") return heuristic;
  const chat = chatClientFromEnv();
  if (!chat) {
    if (mode === "llm") {
      throw new Error(
        "--planner llm requires OPENAI_API_KEY, GROK_API_KEY, or GEMINI_API_KEY"
      );
    }
    return heuristic;
  }
  return new LlmPlanner({
    client: chat.client,
    modelName: chat.modelName,
    fallback: heuristic
  });
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderReport(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`planner: ${report.planner}`);
  lines.push(
    `통과: ${report.passedCases}/${report.totalCases} (${percent(report.passRate)})`
  );
  lines.push(
    `응답 시간: 중앙값 ${(report.medianElapsedMs / 1000).toFixed(2)}s, p95 ${(report.p95ElapsedMs / 1000).toFixed(2)}s`
  );
  lines.push(
    `수작업 기준 ${report.totalManualBaselineMinutes}분 -> 절감 ${report.totalMinutesSaved.toFixed(1)}분`
  );
  lines.push("");
  lines.push("지표별 정확도");
  for (const [name, entry] of Object.entries(report.checkRates)) {
    lines.push(
      `  ${name.padEnd(24)} ${entry.passed}/${entry.applicable}  ${percent(entry.rate)}`
    );
  }
  lines.push("");
  lines.push("질문별 결과");
  for (const result of report.results) {
    lines.push(
      `  ${result.passed ? "PASS" : "FAIL"}  ${result.id.padEnd(26)} ${(result.elapsedMs / 1000).toFixed(2)}s  ${result.intent}`
    );
    for (const check of result.checks) {
      if (check.passed === false) lines.push(`        - ${check.name}: ${check.detail}`);
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  loadRepositoryEnvironment();
  const casesPath = resolve(REPO_ROOT, "evals/benchmark.jsonl");
  const cases = parseBenchmarkCases(await readFile(casesPath, "utf8"));
  const planner = selectPlanner(options.planner);
  const repository = await createDataRepository();
  const registry = createToolRegistry(repository);
  const results: BenchmarkCaseResult[] = [];

  try {
    for (const testCase of cases) {
      const startedAt = performance.now();
      // A crash is scored as a failed case rather than aborting the run,
      // otherwise one bad question hides the results of all the others.
      const answer = await runAgent(registry, testCase.question, planner).catch(
        (error: unknown) => ({
          question: testCase.question,
          planner: planner.name,
          consideredDatasets: [],
          plan: [],
          answered: false,
          conclusion: `실행 오류: ${error instanceof Error ? error.message : String(error)}`,
          evidence: [],
          joins: [],
          sources: [],
          limitations: [],
          rejectedSteps: [],
          unavailableDatasets: []
        })
      );
      results.push(
        scoreBenchmarkCase(testCase, answer, performance.now() - startedAt)
      );
    }
  } finally {
    await repository.close().catch(() => undefined);
  }

  const report = summarizeBenchmark(`${planner.name} (${repository.mode})`, results);
  console.log(renderReport(report));

  if (options.out) {
    const outPath = resolve(REPO_ROOT, options.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\nJSON 보고서: ${outPath}`);
  }

  // Non-zero exit on regression so this can gate a pipeline later.
  if (report.passRate < 1) process.exitCode = 1;
}

await main();
