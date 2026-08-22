/**
 * The instruction both arms receive.
 *
 * Fairness rests on this file. The ungrounded arm is told, in the same words,
 * that it may decline and that it should cite its source — so a refusal or a
 * missing citation reflects what the arm could actually do, not a prompt
 * written to make it fail.
 */
export const SHARED_INSTRUCTION = [
  "당신은 경상북도 공공데이터에 대한 질의에 답하는 분석 보조자입니다.",
  "",
  "규칙:",
  "1. 수치를 묻는 질문에는 아는 범위에서 최선의 수치를 제시하십시오. 정확하지 않아도 좋으니 근사치라도 제시하고, 근사치인 경우 그 사실을 밝히십시오.",
  "2. 출처를 특정할 수 없다는 이유로 수치 제시를 보류하지 마십시오. 출처는 알고 있을 때에만 덧붙이면 됩니다.",
  "3. 해당 값을 짐작할 근거조차 전혀 없을 때에만 '확인할 수 없습니다'라고 답하십시오.",
  "4. 수치를 제시할 때 출처 자료명과 기준 시점을 알고 있다면 함께 밝히십시오.",
  "5. 답변은 한국어로 간결하게 작성하십시오."
].join("\n");

/** Wraps a question in the shared instruction for the ungrounded arm. */
export function buildVanillaPrompt(question: string): string {
  return `${SHARED_INSTRUCTION}\n\n질문: ${question}\n\n답변:`;
}

/**
 * Prompt for the grounded arm's final step.
 *
 * A real MCP client does not stop at the tool call: the retrieved rows go back
 * to the model, which writes the answer. Skipping this step would compare a
 * model against a data dump rather than against the same model with data, so
 * the grounded arm gets the identical instruction plus the evidence it fetched.
 */
export function buildSynthesisPrompt(question: string, evidence: string): string {
  return [
    SHARED_INSTRUCTION,
    "",
    "아래는 경상북도 데이터베이스에서 조회한 실제 자료입니다. 이 자료에 근거해서만 답하십시오.",
    "자료에 답이 없으면 '확인할 수 없습니다'라고 답하십시오.",
    "",
    "[조회 결과]",
    evidence,
    "",
    `질문: ${question}`,
    "",
    "답변:"
  ].join("\n");
}

/**
 * Phrases that signal the answer declined rather than asserted.
 *
 * Detection is lexical and therefore imperfect, but it is applied identically to
 * both arms, so any imprecision does not favour either one.
 */
const REFUSAL_MARKERS = [
  "확인할 수 없",
  "확인이 어렵",
  "알 수 없",
  "answer_unavailable",
  "자료가 없",
  "자료를 찾을 수 없",
  "데이터가 없",
  "데이터를 찾을 수 없",
  "보유하고 있지 않",
  "제공할 수 없",
  "포함되어 있지 않",
  "적재된 자료가 없",
  "정보가 없",
  "답변할 수 없",
  "答えられません"
];

/** True when the text declines to commit to an answer. */
export function looksLikeRefusal(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ");
  return REFUSAL_MARKERS.some((marker) => normalized.includes(marker));
}

/** UUIDs are the only citation form that can be checked against the warehouse. */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function extractSourceIds(text: string): string[] {
  return [...new Set(text.match(UUID_PATTERN) ?? [])].map((id) => id.toLowerCase());
}

/**
 * Institution and publication names offered as backing for a figure.
 *
 * Recorded separately from ids because naming a ministry is a claim about where
 * a number came from, while an id is a pointer that can be followed. The report
 * shows both so the distinction is visible rather than asserted.
 */
const ATTRIBUTION_PATTERN =
  /(행정안전부|통계청|국세청|지방재정365|경상북도[가-힣]{0,6}|[가-힣]{2,6}(?:시청|군청|의회)|주민등록[가-힣]*통계|지방세[가-힣]*통계연감|e-나라지표|KOSIS)/g;

export function extractAttributions(text: string): string[] {
  return [...new Set(text.match(ATTRIBUTION_PATTERN) ?? [])];
}
