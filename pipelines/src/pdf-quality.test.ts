import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "./catalog.js";
import { deterministicUuid, scorePdfPageQuality, type PdfNormalizationPlan } from "./pdf.js";
import {
  buildPdfQualityReport,
  type PdfGoldenFixture
} from "./pdf-quality.js";

function fixturePlan(): {
  catalog: CatalogEntry[];
  fixtures: PdfGoldenFixture[];
  plan: PdfNormalizationPlan;
} {
  const sourcePath = "datasets/golden.pdf";
  const sourceSha256 = "a".repeat(64);
  const rawTextSha256 = "b".repeat(64);
  const page = {
    pageId: deterministicUuid("golden-page"),
    pageKey: "golden-page",
    documentId: deterministicUuid("golden-document"),
    sourceKey: "golden-source",
    sourcePath,
    pageNumber: 2,
    extractionStatus: "extracted" as const,
    contentClassification: "extracted_ok" as const,
    extractionMethod: "native_pdf_text" as const,
    rawContentSha256: rawTextSha256,
    contentSha256: "c".repeat(64),
    text: "○위원장 박영록 질의합니다.",
    error: null,
    extractorVersion: "test",
    quality: scorePdfPageQuality(
      "○위원장 박영록 질의합니다.",
      "○위원장 박영록 질의합니다."
    ),
    metadata: {}
  };
  const summary = {
    files: 1,
    pages: 1,
    extractedPages: 1,
    unusableForRetrievalPages: 0,
    mojibakeSuspectedPages: 0,
    classifiedEmptyPages: 0,
    failedPages: 0,
    emptyPages: 0,
    nearEmptyPages: 1,
    tableLikelyPages: 0,
    speakerRichPages: 0,
    repeatedHeaderLinesRemoved: 0,
    repeatedFooterLinesRemoved: 0,
    chunks: 0,
    extractedDocuments: 1,
    partialDocuments: 0,
    unusableForRetrievalDocuments: 0,
    mojibakeSuspectedDocuments: 0,
    emptyDocuments: 0,
    failedDocuments: 0
  };
  return {
    catalog: [{ path: sourcePath, sha256: sourceSha256 }] as CatalogEntry[],
    fixtures: [
      {
        id: "golden",
        sourcePath,
        sourceSha256,
        pageNumber: 2,
        rawTextSha256,
        reason: "test",
        categories: ["speaker_transition"],
        expectedMarkers: ["○위원장 박영록"],
        minimumSpeakerMarkers: 1
      }
    ],
    plan: {
      sources: [],
      documents: [],
      pages: [page],
      chunks: [],
      locators: [],
      failures: [],
      summary
    }
  };
}

describe("PDF quality report", () => {
  it("is deterministic for fixed inputs and timestamp", () => {
    const input = fixturePlan();
    const first = buildPdfQualityReport(
      input.plan,
      input.catalog,
      input.fixtures
    );
    const second = buildPdfQualityReport(
      input.plan,
      input.catalog,
      input.fixtures
    );
    expect(first).toEqual(second);
    expect(first.golden.passRate).toBe(1);
    expect(first.severeRegressions).toEqual([]);
  });

  it("classifies a golden hash mismatch as a severe regression", () => {
    const input = fixturePlan();
    input.plan.pages[0]!.rawContentSha256 = "d".repeat(64);
    const report = buildPdfQualityReport(
      input.plan,
      input.catalog,
      input.fixtures
    );
    expect(report.golden.passRate).toBe(0);
    expect(report.severeRegressions).toEqual([
      "1 golden fixture(s) failed"
    ]);
  });
});
