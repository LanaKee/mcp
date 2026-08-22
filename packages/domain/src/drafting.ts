import type { DraftPublicDocumentInput } from "./schemas.js";

function evidenceLines(input: DraftPublicDocumentInput): string {
  return input.verifiedAnalysis.evidence
    .map(
      (item, index) =>
        `${index + 1}. ${item.statement}${item.value === undefined ? "" : `: ${item.value}`} [출처: ${item.sourceIds.join(", ")}]`
    )
    .join("\n");
}

export function draftPublicDocument(input: DraftPublicDocumentInput) {
  const sourceIds = new Set(input.verifiedAnalysis.sources.map((source) => source.sourceId));
  if (
    input.verifiedAnalysis.sources.some(
      (source) => source.dataStatus === "demo_sample" || !source.isOfficial
    )
  ) {
    throw new Error(
      "demo_sample 또는 비공식 출처로 공공문서의 검증 근거를 만들 수 없습니다."
    );
  }
  for (const evidence of input.verifiedAnalysis.evidence) {
    for (const sourceId of evidence.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        throw new Error(`근거 sourceId(${sourceId})가 제공된 출처 묶음에 없습니다.`);
      }
    }
  }

  const body =
    input.documentType === "information_request"
      ? `정보공개청구서 초안\n\n1. 청구 제목\n${input.title}\n\n2. 청구 내용\n${input.verifiedAnalysis.conclusion}\n\n3. 공개를 요청하는 자료\n${evidenceLines(input)}\n\n4. 활용 목적\n공공데이터에 근거한 지역 현황 확인 및 공익적 검토`
      : `주민참여예산 제안서 초안\n\n1. 제안명\n${input.title}\n\n2. 현황 및 문제점\n${input.verifiedAnalysis.conclusion}\n\n3. 제안 근거\n${evidenceLines(input)}\n\n4. 제안 내용\n위 검증 자료를 바탕으로 담당 부서의 세부 검토와 주민 의견수렴을 요청합니다.`;

  return {
    label: "검토가 필요한 초안",
    draft: `${body}\n\n5. 한계 및 확인사항\n- ${input.verifiedAnalysis.limitations.join("\n- ")}\n\n※ 본 문서는 제공된 검증 결과와 출처만으로 작성된 초안이며 제출 전 담당 기관 확인이 필요합니다.`,
    usedSourceIds: [...sourceIds],
    dataStatus: input.verifiedAnalysis.sources.some(
      (source) => source.dataStatus === "catalog_only"
    )
      ? ("catalog_only" as const)
      : ("official_observed" as const)
  };
}
