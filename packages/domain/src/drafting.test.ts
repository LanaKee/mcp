import { describe, expect, it } from "vitest";
import { draftPublicDocument } from "./index.js";

const source = {
  sourceId: "sample",
  title: "샘플",
  provider: "프로젝트",
  sourceUrl: null,
  collectedAt: "2026-08-22",
  dataStatus: "demo_sample" as const,
  isOfficial: false,
  note: "예시"
};

describe("grounded drafting", () => {
  it("uses only source ids from the verified bundle and labels the output", () => {
    const result = draftPublicDocument({
      documentType: "information_request",
      title: "인구 및 지방세 자료",
      verifiedAnalysis: {
        conclusion: "인구 감소와 세수 증가가 동시에 관측되었습니다.",
        evidence: [{ statement: "2022~2024 비교", sourceIds: ["sample"] }],
        sources: [source],
        limitations: ["샘플 데이터"],
        verified: true
      }
    });
    expect(result.label).toContain("초안");
    expect(result.draft).toContain("[출처: sample]");
    expect(result.dataStatus).toBe("demo_sample");
  });

  it("rejects evidence outside the supplied source bundle", () => {
    expect(() =>
      draftPublicDocument({
        documentType: "participatory_budget",
        title: "제안",
        verifiedAnalysis: {
          conclusion: "결론",
          evidence: [{ statement: "근거", sourceIds: ["missing"] }],
          sources: [source],
          limitations: ["한계"],
          verified: true
        }
      })
    ).toThrow("제공된 출처 묶음");
  });
});

