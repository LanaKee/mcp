import type { AgentAnswer, AgentEvidence } from "./agent";
import type { AnswerView, Block } from "./blocks";

/**
 * 모델 없이도 화면을 채우는 결정적 렌더러.
 *
 * 모델 호출이 실패하거나 스키마를 어긴 응답을 냈을 때 쓰인다. 여기서 만드는
 * 블록은 전부 에이전트가 돌려준 값을 그대로 옮긴 것이고, 새로 계산하거나
 * 해석하는 값은 없다.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberFormat(value: number): string {
  return new Intl.NumberFormat("ko-KR").format(value);
}

/** 시계열 detail(`{ points: [{ year, value }] }`)을 series 블록으로 옮긴다. */
function seriesBlock(evidence: AgentEvidence): Block | null {
  if (!isRecord(evidence.detail)) return null;
  const raw = evidence.detail.points;
  if (!Array.isArray(raw)) return null;
  const points = raw
    .filter(isRecord)
    .filter((point) => typeof point.year === "number" && typeof point.value === "number")
    .map((point) => ({ label: String(point.year), value: point.value as number }));
  if (points.length < 2) return null;
  const unit = typeof evidence.detail.unit === "string" ? evidence.detail.unit : undefined;
  const region = typeof evidence.detail.region === "string" ? evidence.detail.region : "";
  const first = points[0];
  const last = points[points.length - 1];
  const caption =
    first && last
      ? `${first.label}년 ${numberFormat(first.value)}${unit ?? ""} → ${last.label}년 ${numberFormat(last.value)}${unit ?? ""}`
      : undefined;
  return {
    kind: "series",
    title: `${region} ${evidence.tool.includes("tax") ? "지방세" : "인구"} 추이`.trim().slice(0, 120),
    unit,
    points,
    caption
  };
}

/** 검색형 detail(`{ matches: [...] }`)을 표로 옮긴다. */
function matchesBlock(evidence: AgentEvidence): Block | null {
  if (!isRecord(evidence.detail)) return null;
  const matches = evidence.detail.matches;
  if (!Array.isArray(matches) || matches.length === 0) return null;
  const rows = matches
    .filter(isRecord)
    .slice(0, 8)
    .map((match) => {
      const title = String(match.title ?? match.billName ?? match.name ?? "제목 없음").slice(0, 200);
      const when = String(match.publishedAt ?? match.proposedAt ?? match.date ?? "").slice(0, 200);
      const who = String(
        match.department ?? match.publisher ?? match.committee ?? match.leadMember ?? ""
      ).slice(0, 200);
      return [when, title, who];
    });
  return {
    kind: "table",
    title: "검색 결과",
    columns: ["일자", "제목", "소관"],
    rows,
    caption: `${matches.length}건 중 ${rows.length}건 표시 · 서술 맥락이며 수치 근거가 아닙니다.`
  };
}

export function fallbackView(answer: AgentAnswer): AnswerView {
  const blocks: Block[] = [
    {
      kind: "headline",
      title: answer.conclusion.slice(0, 400),
      subtitle: answer.answered
        ? `${answer.evidence.length}개 근거 · ${answer.sources.length}개 출처`
        : "이 질문은 적재된 데이터로 답할 수 없습니다."
    }
  ];

  for (const evidence of answer.evidence.slice(0, 3)) {
    const block = seriesBlock(evidence) ?? matchesBlock(evidence);
    if (block) blocks.push(block);
  }

  if (blocks.length === 1 && answer.evidence.length > 0) {
    blocks.push({
      kind: "bullets",
      title: "근거",
      items: answer.evidence.slice(0, 6).map((item) => item.statement.slice(0, 400))
    });
  }

  // 답을 낸 경우에는 알리지 않는다.
  //
  // 카탈로그가 훑어본 데이터셋 중 하나가 비어 있다는 것은 이용자의 질문이 아니라
  // 우리 적재 상태에 관한 사실이다. 답이 나온 화면에 "테이블은 있으나 행이 없다"를
  // 붙이면 답과 무관한 내부 사정을 경고처럼 읽게 만든다. 답하지 못한 경우에만
  // 남기는 이유는 그때는 이것이 곧 답할 수 없는 이유이기 때문이다.
  if (!answer.answered) {
    for (const dataset of answer.unavailableDatasets.slice(0, 2)) {
      blocks.push({
        kind: "callout",
        tone: "warn",
        title: `${dataset.title}에 사용할 수 있는 행이 없습니다`,
        text: (dataset.note ?? "이 데이터셋은 비어 있어 근거로 쓰이지 않았습니다.").slice(0, 400)
      });
    }
  }

  if (answer.limitations.length > 0 && blocks.length < 8) {
    blocks.push({
      kind: "bullets",
      title: "해석 시 주의",
      tone: "caution",
      items: answer.limitations.slice(0, 4).map((item) => item.slice(0, 400))
    });
  }

  return {
    summary: answer.conclusion.slice(0, 400),
    blocks: blocks.slice(0, 8)
  };
}
