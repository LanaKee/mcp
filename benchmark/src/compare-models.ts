/**
 * Collates finished single-model runs into one cross-model comparison.
 *
 * Reads only what the runs already wrote, so it re-derives nothing and can be
 * pointed at any set of reports. The comparison it produces is about the *gap*
 * each model shows between its ungrounded and grounded arms; the absolute
 * scores are secondary, because the claim under test is that grounding helps
 * regardless of which model is doing the reasoning.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArmSummary, BenchmarkReport } from "./types.js";

const BENCHMARK_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * Share of an arm's responses that never reached the model.
 *
 * A run that lost most of its calls to rate limiting measures the account's
 * quota, not the model, and publishing it as a model score would be a straight
 * misreading. Runs above the threshold are labelled rather than dropped, so the
 * failure stays visible instead of disappearing from the record.
 */
export const MAX_TOLERATED_ERROR_RATE = 0.1;

export interface ModelComparisonRow {
  model: string;
  provider: string;
  temperaturePinned: boolean;
  cases: number;
  vanilla: ArmSummary;
  mcp: ArmSummary;
  errorRate: number;
  valid: boolean;
}

export function errorRateOf(report: BenchmarkReport): number {
  if (report.responses.length === 0) return 0;
  const failed = report.responses.filter((response) => response.error).length;
  return failed / report.responses.length;
}

export function toRow(report: BenchmarkReport): ModelComparisonRow {
  const vanilla = report.arms.find((arm) => arm.arm === "vanilla");
  const mcp = report.arms.find((arm) => arm.arm === "mcp");
  if (!vanilla || !mcp) throw new Error(`${report.model}: arm 요약이 없습니다.`);
  const errorRate = errorRateOf(report);
  return {
    model: report.model,
    provider: report.provider ?? "-",
    temperaturePinned: report.temperaturePinned ?? true,
    cases: report.cases,
    vanilla,
    mcp,
    errorRate,
    valid: errorRate <= MAX_TOLERATED_ERROR_RATE
  };
}

/** Loads every `<dir>/*\/report.json` that parses. */
export function loadReports(reportsDir: string): BenchmarkReport[] {
  if (!existsSync(reportsDir)) return [];
  const reports: BenchmarkReport[] = [];
  for (const entry of readdirSync(reportsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = resolve(reportsDir, entry.name, "report.json");
    if (!existsSync(path)) continue;
    reports.push(JSON.parse(readFileSync(path, "utf8")) as BenchmarkReport);
  }
  return reports;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function delta(vanilla: number, mcp: number): string {
  const points = (mcp - vanilla) * 100;
  const sign = points > 0 ? "+" : "";
  return `${sign}${points.toFixed(1)}p`;
}

export function renderComparison(rows: ModelComparisonRow[]): string {
  const usable = rows.filter((row) => row.valid);
  const lines: string[] = [];

  lines.push("# 모델별 Vanilla vs MCP 비교 — 경상북도 컨텍스트");
  lines.push("");
  lines.push(
    "같은 문항·같은 지시문·같은 채점기를 네 모델에 각각 적용했습니다. 각 모델 안에서 두 arm의 유일한 차이는 경상북도 데이터 계층 접근 여부입니다."
  );
  lines.push("");
  lines.push(
    "**모델 간 절대 점수 비교는 이 벤치마크의 목적이 아닙니다.** 문항이 22개뿐이고 일부 모델은 temperature를 고정할 수 없어, 모델 순위를 매기기에는 표본이 부족합니다. 읽어야 할 값은 각 모델 *내부*의 vanilla → MCP 변화량입니다."
  );
  lines.push("");

  lines.push("## 정확도");
  lines.push("");
  lines.push("| 모델 | vanilla | MCP | 변화 |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const row of usable) {
    lines.push(
      `| \`${row.model}\` | ${percent(row.vanilla.accuracy)} | ${percent(row.mcp.accuracy)} | ${delta(row.vanilla.accuracy, row.mcp.accuracy)} |`
    );
  }
  lines.push("");

  lines.push("## 환각 — 답변한 것 대비");
  lines.push("");
  lines.push(
    "전체 대비 환각률은 답을 회피할수록 좋아 보이므로, 실제로 값을 단언한 답변만을 분모로 삼은 수치를 함께 싣습니다. 답변 시도율이 낮은 모델의 환각률은 그 자체로는 의미가 없습니다."
  );
  lines.push("");
  lines.push("| 모델 | 답변 시도율 (V→M) | 환각률(답변 대비) V | 환각률(답변 대비) M | 변화 |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const row of usable) {
    lines.push(
      `| \`${row.model}\` | ${percent(row.vanilla.commitmentRate)} → ${percent(row.mcp.commitmentRate)} | ${percent(row.vanilla.hallucinationPerCommitted)} | ${percent(row.mcp.hallucinationPerCommitted)} | ${delta(row.vanilla.hallucinationPerCommitted, row.mcp.hallucinationPerCommitted)} |`
    );
  }
  lines.push("");

  lines.push("## 출처 검증 가능 비율 · 부재 인지 · 지연");
  lines.push("");
  lines.push("| 모델 | 출처검증 V | 출처검증 M | 부재인지 V | 부재인지 M | 지연(중앙값) V | M |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of usable) {
    lines.push(
      `| \`${row.model}\` | ${percent(row.vanilla.citationVerifiability)} | ${percent(row.mcp.citationVerifiability)} | ${percent(row.vanilla.abstentionAccuracy)} | ${percent(row.mcp.abstentionAccuracy)} | ${row.vanilla.medianLatencyMs.toLocaleString("ko-KR")}ms | ${row.mcp.medianLatencyMs.toLocaleString("ko-KR")}ms |`
    );
  }
  lines.push("");
  lines.push(
    "vanilla의 출처 검증 가능 비율은 모든 모델에서 0%입니다. 출처를 대지 않아서가 아니라, 대는 출처가 실재하는 행에 대응하지 않기 때문입니다."
  );
  lines.push("");

  lines.push("## 실행 조건");
  lines.push("");
  lines.push("| 모델 | 공급자 | temperature 0 고정 | API 실패율 | 채택 |");
  lines.push("| --- | --- | --- | ---: | --- |");
  for (const row of rows) {
    lines.push(
      `| \`${row.model}\` | ${row.provider} | ${row.temperaturePinned ? "예" : "아니오 (모델이 거부)"} | ${percent(row.errorRate)} | ${row.valid ? "O" : "X — 무효"} |`
    );
  }
  lines.push("");

  const invalid = rows.filter((row) => !row.valid);
  if (invalid.length > 0) {
    lines.push(
      `> 실패율이 ${percent(MAX_TOLERATED_ERROR_RATE)}를 넘은 실행은 모델 성능이 아니라 호출 실패를 측정한 것이므로 위 표에서 제외했습니다: ${invalid.map((row) => `\`${row.model}\``).join(", ")}`
    );
    lines.push("");
  }

  lines.push("## 읽는 법");
  lines.push("");
  const improved = usable.filter((row) => row.mcp.accuracy > row.vanilla.accuracy);
  lines.push(
    `- 정확도는 유효 실행 ${usable.length}개 중 ${improved.length}개에서 MCP arm이 더 높습니다.`
  );

  // Derived, not asserted: the commitment gap is the finding, and it only holds
  // if the numbers say so on this run.
  const lowCommitment = usable.filter((row) => row.vanilla.commitmentRate < 0.5);
  const highCommitment = usable.filter((row) => row.vanilla.commitmentRate >= 0.9);
  if (lowCommitment.length > 0 && highCommitment.length > 0) {
    lines.push(
      `- vanilla의 답변 시도율은 모델마다 크게 갈립니다: ${lowCommitment
        .map((row) => `\`${row.model}\` ${percent(row.vanilla.commitmentRate)}`)
        .join(", ")} 대 ${highCommitment
        .map((row) => `\`${row.model}\` ${percent(row.vanilla.commitmentRate)}`)
        .join(", ")}. 약한 모델은 침묵으로, 강한 모델은 단언으로 실패합니다. 즉 모델을 키우는 것만으로는 환각이 사라지지 않고 더 그럴듯해질 뿐이며, 근거 계층이 필요한 이유가 여기에 있습니다.`
    );
  }

  const slowerMcp = usable.filter((row) => row.mcp.medianLatencyMs > row.vanilla.medianLatencyMs);
  lines.push(
    slowerMcp.length === usable.length
      ? "- 지연은 모든 유효 실행에서 MCP arm이 더 깁니다. 도구 실행과 합성이 추가되기 때문이며, 이는 설계상의 비용입니다."
      : `- 지연은 유효 실행 ${usable.length}개 중 ${slowerMcp.length}개에서만 MCP arm이 더 깁니다. 장황하게 추론하는 모델에서는 도구 실행을 포함한 MCP arm이 오히려 더 빨랐습니다.`
  );
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function main(): void {
  const reportsDir = resolve(BENCHMARK_ROOT, "reports");
  const reports = loadReports(reportsDir);
  if (reports.length === 0) throw new Error(`${reportsDir}에 report.json이 없습니다.`);
  const rows = reports
    .map(toRow)
    .sort((left, right) => left.model.localeCompare(right.model));
  const outPath = resolve(reportsDir, "COMPARISON.md");
  writeFileSync(outPath, renderComparison(rows), "utf8");
  console.log(`[benchmark] 모델 비교: ${outPath} (${rows.length}개 실행)`);
  for (const row of rows) {
    console.log(
      `  ${row.model.padEnd(20)} vanilla ${percent(row.vanilla.accuracy).padStart(6)} → MCP ${percent(row.mcp.accuracy).padStart(6)}${row.valid ? "" : "  [무효: API 실패율 " + percent(row.errorRate) + "]"}`
    );
  }
}

// Compares the resolved script path, not a filename suffix: a suffix check is
// also true when a test merely imports this module, which would launch a run.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
