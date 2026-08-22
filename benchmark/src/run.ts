/**
 * Runs the comparison end to end.
 *
 * Both arms are driven from one loop so they see identical questions in an
 * identical order, and every intermediate artefact — raw responses, resolved
 * truth, per-case verdicts — is written out. The claim this benchmark makes is
 * only worth as much as a reader's ability to re-check it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../../services/mcp-server/src/agent.js";
import type { Planner } from "../../services/mcp-server/src/agent.js";
import {
  chatClientFromEnv,
  LlmPlanner,
  type ChatCompletion
} from "../../services/mcp-server/src/llm-planner.js";
import { HeuristicPlanner } from "../../services/mcp-server/src/planner.js";
import {
  createDataRepository,
  loadRepositoryEnvironment
} from "../../services/mcp-server/src/runtime.js";
import { createToolRegistry } from "../../services/mcp-server/src/tools.js";
import { runMcpArm } from "./arms/mcp.js";
import { runVanillaArm } from "./arms/vanilla.js";
import { loadBenchmarkCases } from "./cases.js";
import { gradeResponse, summarizeArm } from "./grade.js";
import { PostgresTruthSource, type TruthSource } from "./ground-truth.js";
import { renderMarkdownReport } from "./report.js";
import type {
  ArmResponse,
  BenchmarkCase,
  BenchmarkReport,
  CaseCategory,
  CaseScore,
  ResolvedGroundTruth
} from "./types.js";

// Resolved from the module URL, not cwd: pnpm runs package scripts with the
// package directory as cwd, and the cases live beside this source tree.
const BENCHMARK_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

interface Options {
  casesPath: string;
  outDir: string;
  limit: number | null;
  /** Skips the model entirely and only checks that truth resolution works. */
  dryRun: boolean;
  planner: "auto" | "heuristic" | "llm";
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    casesPath: resolve(BENCHMARK_ROOT, "cases/gyeongbuk.jsonl"),
    outDir: resolve(BENCHMARK_ROOT, "reports"),
    limit: null,
    dryRun: false,
    planner: "auto"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cases" && argv[index + 1]) {
      options.casesPath = resolve(process.cwd(), argv[index + 1] as string);
      index += 1;
    } else if (arg === "--out" && argv[index + 1]) {
      options.outDir = resolve(process.cwd(), argv[index + 1] as string);
      index += 1;
    } else if (arg === "--limit" && argv[index + 1]) {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) options.limit = Math.floor(parsed);
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--planner" && argv[index + 1]) {
      const value = argv[index + 1];
      if (value === "auto" || value === "heuristic" || value === "llm") options.planner = value;
      index += 1;
    }
  }
  return options;
}

function selectPlanner(mode: Options["planner"], chat: ChatCompletion | null, model: string): Planner {
  const heuristic = new HeuristicPlanner();
  if (mode === "heuristic" || chat === null) return heuristic;
  // The deterministic planner backs the model up so that a transient API error
  // is not recorded as the grounded system failing to answer.
  return new LlmPlanner({ client: chat, modelName: model, fallback: heuristic });
}

function categoryBreakdown(
  cases: BenchmarkCase[],
  scores: CaseScore[]
): BenchmarkReport["byCategory"] {
  const categories = [...new Set(cases.map((entry) => entry.category))] as CaseCategory[];
  return categories.map((category) => {
    const ids = new Set(
      cases.filter((entry) => entry.category === category).map((entry) => entry.id)
    );
    const scoped = scores.filter((score) => ids.has(score.caseId));
    const accuracy = (arm: "vanilla" | "mcp"): number => {
      const armScores = scoped.filter((score) => score.arm === arm);
      if (armScores.length === 0) return 0;
      return Number(
        (armScores.filter((score) => score.correct).length / armScores.length).toFixed(4)
      );
    };
    return {
      category,
      cases: ids.size,
      vanillaAccuracy: accuracy("vanilla"),
      mcpAccuracy: accuracy("mcp")
    };
  });
}

async function resolveAllTruth(
  cases: BenchmarkCase[],
  truthSource: TruthSource
): Promise<Map<string, ResolvedGroundTruth>> {
  const resolved = new Map<string, ResolvedGroundTruth>();
  for (const entry of cases) {
    resolved.set(entry.id, await truthSource.resolve(entry.groundTruth));
  }
  return resolved;
}

/**
 * Fails fast when a case's premise no longer matches the warehouse.
 *
 * An abstention case is only meaningful while the data really is missing. If an
 * ingest later fills that gap, the case must be rewritten rather than silently
 * scored against a premise that has become false.
 */
function checkPremises(
  cases: BenchmarkCase[],
  truth: Map<string, ResolvedGroundTruth>
): string[] {
  const problems: string[] = [];
  for (const entry of cases) {
    const resolved = truth.get(entry.id);
    if (resolved === undefined) {
      problems.push(`${entry.id}: 정답을 해석하지 못했습니다.`);
      continue;
    }
    if (entry.expect.type === "absent" && resolved.available) {
      problems.push(
        `${entry.id}: '자료 없음'을 전제하지만 DB에 값이 있습니다 (${resolved.note}).`
      );
    }
    if (entry.expect.type === "numeric" && !resolved.available) {
      problems.push(`${entry.id}: 정답 수치를 DB에서 찾지 못했습니다 (${resolved.note}).`);
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  loadRepositoryEnvironment();

  const allCases = loadBenchmarkCases(options.casesPath);
  const cases = options.limit === null ? allCases : allCases.slice(0, options.limit);
  console.log(`[benchmark] 문항 ${cases.length}건 로드`);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL이 필요합니다 (.env 확인)");
  const truthSource = new PostgresTruthSource(databaseUrl);

  try {
    const truth = await resolveAllTruth(cases, truthSource);
    const problems = checkPremises(cases, truth);
    if (problems.length > 0) {
      console.error("[benchmark] 문항 전제 검증 실패:");
      for (const problem of problems) console.error(`  - ${problem}`);
      throw new Error("문항 전제가 현재 데이터와 맞지 않습니다. 문항을 갱신하십시오.");
    }
    console.log("[benchmark] 정답 해석 및 전제 검증 완료");

    if (options.dryRun) {
      for (const entry of cases) {
        const resolved = truth.get(entry.id);
        console.log(
          `  ${entry.id}: ${resolved?.available ? resolved.value?.toLocaleString("ko-KR") : "자료 없음"} — ${resolved?.note ?? ""}`
        );
      }
      return;
    }

    const chat = chatClientFromEnv();
    if (chat === null) {
      throw new Error(
        "OPENAI_API_KEY, GROK_API_KEY, GEMINI_API_KEY 중 하나가 필요합니다. 두 arm은 반드시 동일 모델을 사용합니다."
      );
    }
    console.log(`[benchmark] 모델: ${chat.modelName} (두 arm 공통)`);

    const repository = await createDataRepository();
    const registry = createToolRegistry(repository);
    const planner = selectPlanner(options.planner, chat.client, chat.modelName);

    const responses: ArmResponse[] = [];
    const scores: CaseScore[] = [];

    for (const [index, entry] of cases.entries()) {
      console.log(`[benchmark] (${index + 1}/${cases.length}) ${entry.id}`);
      const resolved = truth.get(entry.id);
      if (resolved === undefined) continue;

      // Sequential, and vanilla first, so neither arm benefits from a warmed
      // connection pool when latency is compared.
      const vanilla = await runVanillaArm(chat.client, entry.question);
      const mcp = await runMcpArm(registry, planner, chat.client, entry.question);

      for (const response of [vanilla, mcp]) {
        const verified = await truthSource.verifySourceIds(response.citedSourceIds);
        responses.push(response);
        scores.push(
          gradeResponse({
            benchmarkCase: entry,
            truth: resolved,
            response,
            verifiedSourceIds: verified
          })
        );
      }
    }

    await repository.close();

    const report: BenchmarkReport = {
      generatedAt: new Date().toISOString(),
      model: chat.modelName,
      mode: "live",
      cases: cases.length,
      arms: [
        summarizeArm("vanilla", scores, cases),
        summarizeArm("mcp", scores, cases)
      ],
      byCategory: categoryBreakdown(cases, scores),
      scores,
      groundTruth: cases.map((entry) => ({
        caseId: entry.id,
        resolved: truth.get(entry.id) as ResolvedGroundTruth
      })),
      responses,
      minutesSavedOnCorrect: scores
        .filter((score) => score.arm === "mcp" && score.correct)
        .reduce(
          (total, score) =>
            total + (cases.find((entry) => entry.id === score.caseId)?.manualBaselineMinutes ?? 0),
          0
        )
    };

    await mkdir(options.outDir, { recursive: true });
    await writeFile(
      resolve(options.outDir, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      resolve(options.outDir, "report.md"),
      renderMarkdownReport(report, cases),
      "utf8"
    );

    const [vanillaSummary, mcpSummary] = report.arms;
    console.log("");
    console.log(`  정확도       vanilla ${((vanillaSummary?.accuracy ?? 0) * 100).toFixed(1)}%  |  MCP ${((mcpSummary?.accuracy ?? 0) * 100).toFixed(1)}%`);
    console.log(`  환각률       vanilla ${((vanillaSummary?.hallucinationRate ?? 0) * 100).toFixed(1)}%  |  MCP ${((mcpSummary?.hallucinationRate ?? 0) * 100).toFixed(1)}%`);
    console.log(`  출처검증     vanilla ${((vanillaSummary?.citationVerifiability ?? 0) * 100).toFixed(1)}%  |  MCP ${((mcpSummary?.citationVerifiability ?? 0) * 100).toFixed(1)}%`);
    console.log("");
    console.log(`[benchmark] 리포트: ${resolve(options.outDir, "report.md")}`);
  } finally {
    await truthSource.close();
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith("run.ts");
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(`[benchmark] 실패: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
