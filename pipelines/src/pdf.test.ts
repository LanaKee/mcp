import { describe, expect, it } from "vitest";
import {
  chunkPdfPages,
  classifyPdfExtractionError,
  deterministicUuid,
  extractionStatusForPages,
  normalizeExtractedText,
  type ExtractedPdfPage
} from "./pdf.js";

const pages: ExtractedPdfPage[] = [
  {
    pageNumber: 7,
    text: [
      "행정사무감사",
      "청년 정착 지원 사업을 점검하였다. 예산 집행 내역을 확인하였다.",
      "지방소멸 대응을 위해 교통과 의료 접근성을 함께 검토해야 한다.",
      "위원장은 후속 자료 제출을 요구하였다."
    ].join("\n"),
    contentSha256: "a".repeat(64),
    status: "extracted",
    error: null
  }
];

describe("PDF normalization", () => {
  it("normalizes whitespace while retaining Korean paragraphs", () => {
    expect(normalizeExtractedText("  청년   정착\n\n\n지방소멸  대응 ")).toBe(
      "청년 정착\n\n지방소멸 대응"
    );
  });

  it("creates deterministic page-scoped chunks with overlap metadata", () => {
    const first = chunkPdfPages("document-key", deterministicUuid("document-key"), pages, {
      maxChars: 90,
      overlapChars: 20
    });
    const second = chunkPdfPages("document-key", deterministicUuid("document-key"), pages, {
      maxChars: 90,
      overlapChars: 20
    });
    expect(first.length).toBeGreaterThan(1);
    expect(first).toEqual(second);
    expect(first.every((chunk) => chunk.pageStart === 7 && chunk.pageEnd === 7)).toBe(
      true
    );
    expect(first.every((chunk) => chunk.content.length > 0)).toBe(true);
    expect(first.every((chunk) => chunk.content.length <= 90)).toBe(true);
    expect(first[0]?.sectionTitle).toBe("행정사무감사");
  });

  it("classifies encrypted and general extraction failures explicitly", () => {
    expect(
      classifyPdfExtractionError(
        Object.assign(new Error("No password given"), { name: "PasswordException" })
      ).status
    ).toBe("password_required");
    expect(classifyPdfExtractionError(new Error("invalid xref")).status).toBe(
      "extraction_failed"
    );
    expect(
      extractionStatusForPages([
        {
          pageNumber: 1,
          text: "",
          contentSha256: "c".repeat(64),
          status: "ocr_required",
          error: null
        }
      ])
    ).toBe("ocr_required");
  });
});
