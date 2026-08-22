/**
 * Renders the comparison as Markdown.
 *
 * The report leads with the categories where the two arms differ least, so a
 * reader meets the caveats before the headline. A result that only looks good
 * when read in a particular order is not a result.
 */

import type { BenchmarkCase, BenchmarkReport, CaseScore } from "./types.js";

const CATEGORY_LABEL: Record<string, string> = {
  common_knowledge: "일반 상식 (대조군)",
  recency: "최신성 (학습 컷오프 이후)",
  hyperlocal: "지역 밀착 (소규모 지자체)",
  precision: "정밀도 (원 단위·건수)",
  abstention: "부재 인지 (답하지 않아야 함)",
  provenance: "출처 검증 가능성"
};

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function verdict(vanilla: number, mcp: number): string {
  if (mcp > vanilla) return "MCP 우위";
  if (vanilla > mcp) return "vanilla 우위";
  return "동률";
}

function scoreFor(scores: CaseScore[], caseId: string, arm: "vanilla" | "mcp"): CaseScore | null {
  return scores.find((score) => score.caseId === caseId && score.arm === arm) ?? null;
}

function mark(score: CaseScore | null): string {
  if (score === null) return "-";
  if (score.correct) return "O";
  if (score.hallucinated) return "X (환각)";
  return "△ (보류)";
}

export function renderMarkdownReport(report: BenchmarkReport, cases: BenchmarkCase[]): string {
  const vanilla = report.arms.find((arm) => arm.arm === "vanilla");
  const mcp = report.arms.find((arm) => arm.arm === "mcp");
  if (!vanilla || !mcp) throw new Error("report is missing an arm summary");

  const lines: string[] = [];
  lines.push("# Vanilla vs MCP 벤치마크 — 경상북도 컨텍스트");
  lines.push("");

  // A run that lost most of its calls measures the account's quota, not the
  // model. The warning goes above the numbers because a reader who scrolls to
  // a table first must not meet the scores without it.
  const failed = report.responses.filter((response) => response.error).length;
  const errorRate = report.responses.length === 0 ? 0 : failed / report.responses.length;
  if (errorRate > 0.1) {
    lines.push(
      `> **이 실행은 무효입니다.** 호출 ${report.responses.length}건 중 ${failed}건(${percent(errorRate)})이 API 오류로 모델에 도달하지 못했습니다. 아래 점수는 모델 성능이 아니라 호출 실패율을 반영하므로 인용해서는 안 됩니다.`
    );
    lines.push("");
  }
  lines.push(
    `- 생성 시각: ${report.generatedAt}`,
    `- 모델: \`${report.model}\`${report.provider ? ` (${report.provider})` : ""} (두 arm 동일)`,
    `- 샘플링: ${report.temperaturePinned === false ? "temperature 고정 불가 — 모델이 거부하여 공급자 기본값 사용 (재현성 낮음)" : "temperature 0 고정"}`,
    `- 실행 모드: ${report.mode}`,
    `- 문항 수: ${report.cases}`
  );
  lines.push("");
  lines.push(
    "두 arm은 같은 모델, 같은 지시문, 같은 질문을 받습니다. 유일한 차이는 경상북도 데이터 계층에 접근할 수 있는지 여부입니다."
  );
  lines.push("");

  lines.push("## 종합");
  lines.push("");
  lines.push("| 지표 | vanilla | MCP | 판정 |");
  lines.push("| --- | ---: | ---: | --- |");
  lines.push(
    `| 정확도 | ${percent(vanilla.accuracy)} | ${percent(mcp.accuracy)} | ${verdict(vanilla.accuracy, mcp.accuracy)} |`
  );
  lines.push(
    `| 답변 시도율 | ${percent(vanilla.commitmentRate)} | ${percent(mcp.commitmentRate)} | ${verdict(vanilla.commitmentRate, mcp.commitmentRate)} |`
  );
  lines.push(
    `| 환각률 (전체 문항 대비) | ${percent(vanilla.hallucinationRate)} | ${percent(mcp.hallucinationRate)} | ${verdict(1 - vanilla.hallucinationRate, 1 - mcp.hallucinationRate)} |`
  );
  lines.push(
    `| 환각률 (답변한 문항 대비) | ${percent(vanilla.hallucinationPerCommitted)} | ${percent(mcp.hallucinationPerCommitted)} | ${verdict(1 - vanilla.hallucinationPerCommitted, 1 - mcp.hallucinationPerCommitted)} |`
  );
  lines.push(
    `| 부재 인지 정확도 | ${percent(vanilla.abstentionAccuracy)} | ${percent(mcp.abstentionAccuracy)} | ${verdict(vanilla.abstentionAccuracy, mcp.abstentionAccuracy)} |`
  );
  lines.push(
    `| 출처 검증 가능 비율 | ${percent(vanilla.citationVerifiability)} | ${percent(mcp.citationVerifiability)} | ${verdict(vanilla.citationVerifiability, mcp.citationVerifiability)} |`
  );
  lines.push(
    `| 응답 지연 중앙값 | ${vanilla.medianLatencyMs.toLocaleString("ko-KR")}ms | ${mcp.medianLatencyMs.toLocaleString("ko-KR")}ms | ${verdict(-vanilla.medianLatencyMs, -mcp.medianLatencyMs)} |`
  );
  lines.push(`| 호출 실패 | ${vanilla.errors} | ${mcp.errors} | - |`);
  lines.push("");
  lines.push(
    "> 환각률은 반드시 답변 시도율과 함께 읽어야 합니다. 모든 질문에 답하지 않는 시스템은 환각률 0%를 기록하지만 아무 쓸모가 없습니다. '답변한 문항 대비 환각률'이 두 arm을 같은 조건에서 비교한 값입니다."
  );
  lines.push("");
  lines.push(
    "> 출처 검증 가능 비율은 답변이 제시한 출처 중, 실제 `data_source` 테이블의 행으로 조회되는 것의 비율입니다. 기관명 언급은 귀속(attribution)일 뿐 검증 가능한 출처가 아니므로 분모에는 포함되고 분자에는 포함되지 않습니다."
  );
  lines.push("");

  lines.push("## 범주별 정확도");
  lines.push("");
  lines.push("| 범주 | 문항 | vanilla | MCP | 판정 |");
  lines.push("| --- | ---: | ---: | ---: | --- |");
  for (const row of report.byCategory) {
    lines.push(
      `| ${CATEGORY_LABEL[row.category] ?? row.category} | ${row.cases} | ${percent(row.vanillaAccuracy)} | ${percent(row.mcpAccuracy)} | ${verdict(row.vanillaAccuracy, row.mcpAccuracy)} |`
    );
  }
  lines.push("");

  lines.push("## 문항별 결과");
  lines.push("");
  lines.push("| 문항 | 범주 | 정답 | vanilla | MCP |");
  lines.push("| --- | --- | ---: | --- | --- |");
  const truthById = new Map(report.groundTruth.map((entry) => [entry.caseId, entry.resolved]));
  for (const entry of cases) {
    const truth = truthById.get(entry.id);
    const answer =
      truth === undefined || !truth.available || truth.value === null
        ? "자료 없음"
        : truth.value.toLocaleString("ko-KR");
    lines.push(
      `| \`${entry.id}\` | ${CATEGORY_LABEL[entry.category] ?? entry.category} | ${answer} | ${mark(scoreFor(report.scores, entry.id, "vanilla"))} | ${mark(scoreFor(report.scores, entry.id, "mcp"))} |`
    );
  }
  lines.push("");

  lines.push("## 업무 시간 환산");
  lines.push("");
  lines.push(
    `MCP arm이 정확히 답한 문항을 담당자가 수작업으로 처리했을 때의 추정 소요는 총 **${report.minutesSavedOnCorrect}분** (약 ${(report.minutesSavedOnCorrect / 60).toFixed(1)}시간)입니다. 문항별 추정치는 원자료 위치 확인, 파일 열람, 수치 대조에 드는 시간을 기준으로 산정했습니다.`
  );
  lines.push("");

  lines.push("## 문항 설계 근거");
  lines.push("");
  for (const entry of cases) {
    lines.push(`- **\`${entry.id}\`** (${CATEGORY_LABEL[entry.category] ?? entry.category}) — ${entry.rationale}`);
  }
  lines.push("");

  return lines.join("\n");
}
