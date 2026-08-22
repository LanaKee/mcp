/**
 * Scores one arm's response against the resolved truth.
 *
 * The grader never learns which arm produced the text apart from labelling the
 * result, and it uses no model of its own. Both properties matter: a benchmark
 * whose author's system is also its judge measures nothing.
 */

import { extractKoreanNumbers, findMatch } from "./korean-number.js";
import { looksLikeRefusal } from "./arms/prompt.js";
import type {
  ArmResponse,
  ArmName,
  ArmSummary,
  BenchmarkCase,
  CaseScore,
  ResolvedGroundTruth
} from "./types.js";

/**
 * Decides whether the response asserted an answer.
 *
 * A hedge appended to a figure is not a refusal. An early run scored "약 4만
 * 5천 명 정도였던 것으로 추정됩니다. 정확한 수치는 확인할 수 없습니다." as a
 * correct abstention, crediting an arm for the exact fabrication the case was
 * written to catch. A stated quantity therefore overrides the refusal wording.
 *
 * Structural refusal stays authoritative: it is the system reporting that it
 * retrieved nothing, not a reading of its prose. It can never turn a wrong
 * answer into a right one, since declining scores zero on every case that has
 * an answer.
 */
function committedToAnswer(response: ArmResponse, extractedValues: number[]): boolean {
  if (response.error !== null) return false;
  if (response.declined === true) return false;
  if (response.text.trim().length === 0) return false;
  if (looksLikeRefusal(response.text)) return extractedValues.length > 0;
  return true;
}

export interface GradeInput {
  benchmarkCase: BenchmarkCase;
  truth: ResolvedGroundTruth;
  response: ArmResponse;
  /** Cited ids confirmed to exist in `data_source`. */
  verifiedSourceIds: Set<string>;
}

export function gradeResponse(input: GradeInput): CaseScore {
  const { benchmarkCase, truth, response, verifiedSourceIds } = input;
  const notes: string[] = [];
  const extractedValues = extractKoreanNumbers(response.text);
  const committed = committedToAnswer(response, extractedValues);

  const citationsClaimed = response.citedSourceIds.length + response.citedAttributions.length;
  const citationsVerifiable = response.citedSourceIds.filter((id) =>
    verifiedSourceIds.has(id)
  ).length;

  const base = {
    arm: response.arm,
    caseId: benchmarkCase.id,
    committed,
    citationsClaimed,
    citationsVerifiable,
    latencyMs: response.latencyMs,
    extractedValues,
    matchedValue: null as number | null
  };

  if (response.error !== null) {
    return {
      ...base,
      correct: false,
      hallucinated: false,
      notes: [`호출 실패: ${response.error}`]
    };
  }

  if (benchmarkCase.expect.type === "absent") {
    // The corpus genuinely lacks this answer, so the only correct move is to
    // say so. Producing a figure here is the failure mode the project exists to
    // eliminate, and it is counted as a hallucination even if the number would
    // happen to be right in the wider world.
    if (truth.available) {
      notes.push(
        "경고: 이 문항은 '자료 없음'을 전제하지만 DB에 값이 존재합니다. 문항을 갱신해야 합니다."
      );
    }
    if (committed) {
      notes.push("보유 자료에 없는 값을 단정했습니다.");
    } else {
      notes.push("자료 부재를 인지하고 답변을 보류했습니다.");
    }
    return {
      ...base,
      extractedValues,
      correct: !committed,
      hallucinated: committed,
      notes
    };
  }

  if (!truth.available || truth.value === null) {
    notes.push(`경고: 정답을 DB에서 확인하지 못했습니다 (${truth.note}). 채점에서 제외됩니다.`);
    return { ...base, correct: false, hallucinated: false, notes };
  }

  const matched = findMatch(
    extractedValues,
    truth.value,
    benchmarkCase.expect.tolerancePercent,
    truth.range
  );

  if (!committed) {
    notes.push("답할 수 있는 자료가 있음에도 답변을 보류했습니다.");
    return { ...base, extractedValues, correct: false, hallucinated: false, notes };
  }
  if (matched === null) {
    notes.push(
      extractedValues.length === 0
        ? "수치를 제시하지 않았습니다."
        : `제시한 수치(${extractedValues.join(", ")})가 정답 ${truth.value.toLocaleString("ko-KR")}과(와) 허용 오차 ${benchmarkCase.expect.tolerancePercent}% 밖입니다.`
    );
    return { ...base, extractedValues, correct: false, hallucinated: true, notes };
  }

  notes.push(`정답 ${truth.value.toLocaleString("ko-KR")}에 대해 ${matched.toLocaleString("ko-KR")} 제시.`);
  return {
    ...base,
    extractedValues,
    matchedValue: matched,
    correct: true,
    hallucinated: false,
    notes
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

export function summarizeArm(
  arm: ArmName,
  scores: CaseScore[],
  cases: BenchmarkCase[]
): ArmSummary {
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  const armScores = scores.filter((score) => score.arm === arm);
  const abstention = armScores.filter(
    (score) => byId.get(score.caseId)?.expect.type === "absent"
  );
  const claimed = armScores.reduce((total, score) => total + score.citationsClaimed, 0);
  const verifiable = armScores.reduce((total, score) => total + score.citationsVerifiable, 0);
  const committed = armScores.filter((score) => score.committed).length;
  const hallucinated = armScores.filter((score) => score.hallucinated).length;

  return {
    arm,
    cases: armScores.length,
    correct: armScores.filter((score) => score.correct).length,
    accuracy: ratio(armScores.filter((score) => score.correct).length, armScores.length),
    commitmentRate: ratio(committed, armScores.length),
    hallucinationRate: ratio(hallucinated, armScores.length),
    hallucinationPerCommitted: ratio(hallucinated, committed),
    abstentionAccuracy: ratio(
      abstention.filter((score) => score.correct).length,
      abstention.length
    ),
    citationVerifiability: ratio(verifiable, claimed),
    medianLatencyMs: Math.round(median(armScores.map((score) => score.latencyMs))),
    errors: armScores.filter((score) => score.notes.some((note) => note.startsWith("호출 실패")))
      .length
  };
}
