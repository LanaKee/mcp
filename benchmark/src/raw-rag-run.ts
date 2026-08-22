import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  chatClientFor,
  chatClientFromEnv,
  LlmPlanner
} from "../../services/mcp-server/src/llm-planner.js";
import { HeuristicPlanner } from "../../services/mcp-server/src/planner.js";
import {
  createDataRepository,
  loadRepositoryEnvironment
} from "../../services/mcp-server/src/runtime.js";
import { createToolRegistry } from "../../services/mcp-server/src/tools.js";
import { runMcpArm } from "./arms/mcp.js";
import { loadRawCorpus, runRawRagArm } from "./arms/raw-rag.js";
import { loadBenchmarkCases } from "./cases.js";
import { gradeResponse, summarizeArm } from "./grade.js";
import { PostgresTruthSource } from "./ground-truth.js";
import type {
  BenchmarkCase,
  CaseScore,
  RecordedResponse,
  ResolvedGroundTruth
} from "./types.js";

const BENCHMARK_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(BENCHMARK_ROOT, "..");
const DEFAULT_CASE_IDS = new Set([
  "pr-pohang-tax-2024",
  "pr-gimcheon-tax-2024",
  "pr-gumi-tax-2024",
  "pr-gyeongsan-tax-burden-2024",
  "ab-uljin-pop-2015",
  "ab-cheongsong-pop-2024",
  "ab-policy-programs",
  "pv-pohang-pop-source",
  "pv-gimcheon-tax-source",
  "rc-gimcheon-pop-2026"
]);

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function sourcePaths(databaseUrl: string): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ file_path: string }>(
      `SELECT DISTINCT file_path
         FROM data_source
        WHERE file_path IS NOT NULL
          AND data_status IN ('official_observed', 'catalog_only')
        ORDER BY file_path`
    );
    return result.rows.map((row) => row.file_path);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  loadRepositoryEnvironment();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL이 필요합니다 (.env 확인)");
  const model = argument("--model");
  const selected = model
    ? chatClientFor(model, process.env, { timeoutMs: 180_000, maxRetries: 4 })
    : chatClientFromEnv();
  if (!selected) throw new Error("사용 가능한 LLM API key가 없습니다.");

  const casesArgument = argument("--cases");
  const casesPath = casesArgument
    ? resolve(process.cwd(), casesArgument)
    : resolve(BENCHMARK_ROOT, "cases/gyeongbuk.jsonl");
  const suite = basename(casesPath, ".jsonl");
  const allCases = loadBenchmarkCases(casesPath);
  const cases = allCases.filter((entry) => DEFAULT_CASE_IDS.has(entry.id));
  const truthSource = new PostgresTruthSource(databaseUrl);
  const repository = await createDataRepository();
  try {
    const rawCorpus = await loadRawCorpus(
      REPOSITORY_ROOT,
      await sourcePaths(databaseUrl)
    );
    console.log(
      `[raw-rag] ${rawCorpus.loadedFiles} files / ${rawCorpus.documents.length} chunks loaded (${rawCorpus.skippedFiles} skipped)`
    );
    const registry = createToolRegistry(repository);
    const planner = new LlmPlanner({
      client: selected.client,
      modelName: selected.modelName,
      fallback: new HeuristicPlanner()
    });
    const scores: CaseScore[] = [];
    const responses: RecordedResponse[] = [];
    const groundTruth: Array<{ caseId: string; resolved: ResolvedGroundTruth }> = [];

    for (const [index, benchmarkCase] of cases.entries()) {
      console.log(`[raw-rag] (${index + 1}/${cases.length}) ${benchmarkCase.id}`);
      const truth = await truthSource.resolve(benchmarkCase.groundTruth);
      groundTruth.push({ caseId: benchmarkCase.id, resolved: truth });
      for (const response of [
        await runRawRagArm(rawCorpus, selected.client, benchmarkCase.question),
        await runMcpArm(registry, planner, selected.client, benchmarkCase.question)
      ]) {
        const verified = await truthSource.verifySourceIds(response.citedSourceIds);
        responses.push({ ...response, caseId: benchmarkCase.id });
        scores.push(
          gradeResponse({
            benchmarkCase,
            truth,
            response,
            verifiedSourceIds: verified
          })
        );
      }
    }

    const raw = summarizeArm("raw_rag", scores, cases);
    const mcp = summarizeArm("mcp", scores, cases);
    const generatedAt = new Date().toISOString();
    const outDir = resolve(
      BENCHMARK_ROOT,
      "reports",
      `raw-rag-vs-mcp-${selected.modelName.replace(/[^a-zA-Z0-9._-]+/g, "-")}${
        suite === "gyeongbuk" ? "" : `-${suite}`
      }`
    );
    const report = {
      generatedAt,
      model: selected.modelName,
      suite,
      cases: cases.length,
      corpus: {
        selection: "all data_source.file_path values; raw bytes only",
        loadedFiles: rawCorpus.loadedFiles,
        skippedFiles: rawCorpus.skippedFiles,
        chunks: rawCorpus.documents.length
      },
      arms: [raw, mcp],
      scores,
      groundTruth,
      responses
    };
    const markdown = [
      `# Raw Document Retrieval vs Structured Data Layer — 10문항 차별성 실험 (${suite})`,
      "",
      `- 생성 시각: ${generatedAt}`,
      `- 모델: \`${selected.modelName}\` (양 arm 동일)`,
      `- raw corpus: ${rawCorpus.loadedFiles} files / ${rawCorpus.documents.length} chunks / ${rawCorpus.skippedFiles} skipped`,
      "- Raw Document Retrieval (RAG): 등록된 원본 파일을 단순 lexical retrieval하여 모델에 전달",
      "- Structured Data Layer (MCP): 정규화 + metadata + provenance + coverage + tool 계층",
      "",
      "| 지표 | Raw Retrieval | Structured Layer |",
      "| --- | ---: | ---: |",
      `| 정확도 | ${percent(raw.accuracy)} | ${percent(mcp.accuracy)} |`,
      `| 답변 시도율 | ${percent(raw.commitmentRate)} | ${percent(mcp.commitmentRate)} |`,
      `| 환각률 (답변 대비) | ${percent(raw.hallucinationPerCommitted)} | ${percent(mcp.hallucinationPerCommitted)} |`,
      `| 부재 인지 정확도 | ${percent(raw.abstentionAccuracy)} | ${percent(mcp.abstentionAccuracy)} |`,
      `| 출처 검증 가능 비율 | ${percent(raw.citationVerifiability)} | ${percent(mcp.citationVerifiability)} |`,
      "",
      "| 문항 | Raw RAG | MCP |",
      "| --- | --- | --- |",
      ...cases.map((entry: BenchmarkCase) => {
        const mark = (arm: "raw_rag" | "mcp") => {
          const score = scores.find(
            (candidate) => candidate.caseId === entry.id && candidate.arm === arm
          );
          return score?.correct ? "O" : score?.hallucinated ? "X (환각)" : "△ (보류)";
        };
        return `| \`${entry.id}\` | ${mark("raw_rag")} | ${mark("mcp")} |`;
      }),
      "",
      "> Raw RAG도 원본 corpus를 고르는 최소 curation은 필요합니다. 이 실험은 정규화·지표 의미·coverage·provenance 계층의 추가 효과를 측정하며, 완전 무가공 수집 비용까지 비교하지는 않습니다.",
      ""
    ].join("\n");
    await mkdir(outDir, { recursive: true });
    await writeFile(resolve(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(resolve(outDir, "report.md"), markdown);
    console.log(`[raw-rag] 정확도 ${percent(raw.accuracy)} -> ${percent(mcp.accuracy)}`);
    console.log(`[raw-rag] 리포트: ${resolve(outDir, "report.md")}`);
  } finally {
    await Promise.all([truthSource.close(), repository.close()]);
  }
}

main().catch((error: unknown) => {
  console.error(`[raw-rag] 실패: ${(error as Error).message}`);
  process.exitCode = 1;
});
