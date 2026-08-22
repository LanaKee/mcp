import { describe, expect, it } from "vitest";
import {
  classifyDocumentKoreanText,
  scoreKoreanTextPlausibility
} from "./korean-text-quality.js";

describe("Korean PDF text plausibility", () => {
  it("accepts short administrative Korean with particles and valid word structure", () => {
    const text =
      "경상북도는 청년 농업인을 지원하기 위한 스마트팜 사업을 추진합니다. 지역 인구감소 대응 계획과 예산을 함께 수립합니다.";
    const result = classifyDocumentKoreanText(text.repeat(6), true);
    expect(result.classification).toBe("extracted_ok");
    expect(result.evidence.administrativeTermHitCount).toBeGreaterThan(5);
    expect(result.evidence.validHangulBigramRatio).toBeGreaterThan(0.05);
    expect(result.evidence.particleTokenRatio).toBeGreaterThan(0.01);
  });

  it("detects CID-style Hangul-range gibberish instead of trusting Hangul ratio", () => {
    const text =
      "빃켇쐚싊 붆흖칻뺂 쭒왪휺숾 뺂쭒왪휺 빃켇쐚싊 붆흖칻뺂 쭒왪휺숾 ".repeat(
        20
      );
    const result = classifyDocumentKoreanText(text, true);
    expect(result.classification).toBe("mojibake_suspected");
    expect(result.evidence.hangulRatio).toBeGreaterThan(0.8);
    expect(result.evidence.validHangulBigramRatio).toBe(0);
    expect(result.evidence.particleTokenRatio).toBe(0);
    expect(result.evidence.rareHangulSyllableRatio).toBeGreaterThan(0.5);
  });

  it("marks image-only or non-Korean artifact text as unusable", () => {
    expect(classifyDocumentKoreanText("", true).classification).toBe(
      "unusable_for_retrieval"
    );
    const artifacts = scoreKoreanTextPlausibility(
      "CID: 0012 0045 0088 //// 2024".repeat(30)
    );
    expect(artifacts.hangulCharacterCount).toBe(0);
    expect(
      classifyDocumentKoreanText(
        "CID: 0012 0045 0088 //// 2024".repeat(30),
        true
      ).classification
    ).toBe("unusable_for_retrieval");
  });
});
