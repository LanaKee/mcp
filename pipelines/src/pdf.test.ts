import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PDF_CHUNKER_VERSION,
  chunkPdfPages,
  classifyPdfExtractionError,
  deterministicUuid,
  extractionStatusForPages,
  isLikelyTableLine,
  normalizeExtractedText,
  normalizePdfPages,
  scorePdfPageQuality,
  type ExtractedPdfPage,
  type PdfPagePlan
} from "./pdf.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pagePlan(text: string, pageNumber = 7): PdfPagePlan {
  return {
    pageId: deterministicUuid(`page-${pageNumber}`),
    pageKey: `page-${pageNumber}`,
    documentId: deterministicUuid("document-key"),
    sourceKey: "source-key",
    sourcePath: "datasets/example.pdf",
    pageNumber,
    extractionStatus: "extracted",
    contentClassification: "extracted_ok",
    extractionMethod: "native_pdf_text",
    rawContentSha256: hash(text),
    contentSha256: hash(text),
    text,
    error: null,
    extractorVersion: "test",
    quality: scorePdfPageQuality(text, text),
    metadata: {}
  };
}

const pages = [
  pagePlan(
    [
      "행정사무감사",
      "청년 정착 지원 사업을 점검하였다. 예산 집행 내역을 확인하였다.",
      "지방소멸 대응을 위해 교통과 의료 접근성을 함께 검토해야 한다.",
      "위원장은 후속 자료 제출을 요구하였다."
    ].join("\n")
  )
];

describe("PDF normalization", () => {
  it("normalizes whitespace while retaining Korean paragraphs and table tabs", () => {
    expect(normalizeExtractedText("  청년   정착\n\n\n지방소멸  대응 ")).toBe(
      "청년 정착\n\n지방소멸 대응"
    );
    expect(normalizeExtractedText("사업명\t 예산액 \t 집행액")).toBe(
      "사업명\t예산액\t집행액"
    );
  });

  it("creates deterministic versioned chunks without duplicate-only overlap", () => {
    const options = { maxChars: 90, overlapChars: 20 };
    const first = chunkPdfPages(
      "document-key",
      deterministicUuid("document-key"),
      pages,
      options
    );
    const second = chunkPdfPages(
      "document-key",
      deterministicUuid("document-key"),
      pages,
      options
    );
    expect(first.length).toBeGreaterThan(1);
    expect(first).toEqual(second);
    expect(first.every((chunk) => chunk.chunkKey.includes(PDF_CHUNKER_VERSION))).toBe(
      true
    );
    expect(first.every((chunk) => chunk.pageStart === 7 && chunk.pageEnd === 7)).toBe(
      true
    );
    expect(first.every((chunk) => chunk.content.length > 0)).toBe(true);
    expect(first.every((chunk) => chunk.content.length <= 90)).toBe(true);
    expect(new Set(first.map((chunk) => chunk.contentSha256)).size).toBe(first.length);
    expect(first[0]?.sectionTitle).toBe("행정사무감사");
  });

  it("never chunks pages excluded as mojibake or unusable", () => {
    const rawText = "빃켇쐚싊 붆흖칻뺂 쭒왪휺숾 ".repeat(20);
    const excluded = normalizePdfPages(
      "corrupt-document",
      deterministicUuid("corrupt-document"),
      "source",
      "datasets/extra/dojeong_2020.pdf",
      [
        {
          pageNumber: 1,
          rawText,
          rawContentSha256: hash(rawText),
          status: "extracted",
          hasVisualContent: true,
          error: null
        }
      ],
      "mojibake_suspected"
    );
    expect(excluded[0]?.contentClassification).toBe("mojibake_suspected");
    expect(excluded[0]?.text).toBe("");
    expect(
      chunkPdfPages(
        "corrupt-document",
        deterministicUuid("corrupt-document"),
        excluded
      )
    ).toEqual([]);
  });

  it("removes only confident repeated margins and preserves navigation prose", () => {
    const extracted: ExtractedPdfPage[] = Array.from({ length: 4 }, (_, index) => {
      const rawText = [
        `제226회 회의록 ${index + 1}`,
        "위원장은 자료 제출을 요구하였다.",
        `본문 내용 ${index + 1}입니다.`,
        `다음 ${index + 2}쪽입니다.`,
        `김천시의회 - ${index + 1}`
      ].join("\n");
      return {
        pageNumber: index + 1,
        rawText,
        rawContentSha256: hash(rawText),
        status: "extracted" as const,
        hasVisualContent: true,
        error: null
      };
    });
    const normalized = normalizePdfPages(
      "document",
      deterministicUuid("document"),
      "source",
      "datasets/example.pdf",
      extracted
    );
    expect(normalized.every((page) => !page.text.includes("제226회 회의록"))).toBe(
      true
    );
    expect(normalized.every((page) => !page.text.includes("김천시의회 -"))).toBe(
      true
    );
    expect(
      normalized.every((page) =>
        page.text.includes("위원장은 자료 제출을 요구하였다.")
      )
    ).toBe(true);
    expect(normalized.every((page) => page.text.includes("다음"))).toBe(true);
    expect(normalized[0]?.quality.repeatedHeaderLineCount).toBe(1);
    expect(normalized[0]?.quality.repeatedFooterLineCount).toBe(1);
  });

  it("keeps Korean speaker turns atomic and cuts only at transitions", () => {
    const chunks = chunkPdfPages(
      "speaker-document",
      deterministicUuid("speaker-document"),
      [
        pagePlan(
          [
            "○위원장 박영록 첫 번째 질의를 하겠습니다.",
            "관련 자료를 제출해 주십시오.",
            "○사회복지과장 이봉숙 예, 제출하겠습니다.",
            "○김응숙위원 집행 내역도 포함해 주십시오."
          ].join("\n")
        )
      ],
      { maxChars: 70, overlapChars: 20 }
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.startsWith("○"))).toBe(true);
    expect(chunks.some((chunk) => chunk.content.startsWith("관련 자료"))).toBe(false);
    const combined = chunks.map((chunk) => chunk.content).join("\n");
    expect(combined.match(/○위원장 박영록/gu)).toHaveLength(1);
    expect(combined.match(/○사회복지과장 이봉숙/gu)).toHaveLength(1);
    expect(combined.match(/○김응숙위원/gu)).toHaveLength(1);
  });

  it("preserves table-like rows as coherent line-bounded chunks", () => {
    const table = [
      "사업명\t예산액\t집행액",
      "청년정착\t100,000\t80,000",
      "교통지원\t50,000\t45,000"
    ].join("\n");
    expect(table.split("\n").every(isLikelyTableLine)).toBe(true);
    const chunks = chunkPdfPages(
      "table-document",
      deterministicUuid("table-document"),
      [pagePlan(table)],
      { maxChars: 1200 }
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe(table);
    expect(chunks[0]?.metadata.segmentTypes).toEqual(["table"]);
  });

  it("scores empty, glyph-damaged, table, and speaker-heavy pages", () => {
    expect(scorePdfPageQuality("", "").textClass).toBe("empty");
    expect(scorePdfPageQuality("짧음", "짧음").textClass).toBe("near_empty");
    const quality = scorePdfPageQuality(
      "\n○위원장 박영록 질의합니다.",
      [
        "○위원장 박영록 질의합니다.",
        "○김응숙위원 답변 바랍니다.",
        "○사회복지과장 이봉숙 답변합니다.",
        "사업\t예산\t집행",
        "청년\t100\t80",
        "교통\t50\t45"
      ].join("\n")
    );
    expect(quality.replacementControlGlyphRatio).toBeGreaterThan(0);
    expect(quality.speakerMarkerCount).toBe(3);
    expect(quality.likelyTableLineCount).toBe(3);
    expect(quality.flags).toContain("table_likely");
  });

  it("classifies encrypted, unusable, and general extraction failures explicitly", () => {
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
          rawText: "",
          rawContentSha256: hash(""),
          status: "unusable_for_retrieval",
          hasVisualContent: true,
          error: null
        }
      ])
    ).toBe("unusable_for_retrieval");
  });
});
