import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CatalogEntry } from "./catalog.js";
import { repositoryRoot } from "./etl.js";
import {
  PDF_CHUNKER_VERSION,
  PDF_EXTRACTOR_VERSION,
  type PdfNormalizationPlan,
  type PdfPagePlan
} from "./pdf.js";

export interface PdfGoldenFixture {
  id: string;
  sourcePath: string;
  sourceSha256: string;
  pageNumber: number;
  rawTextSha256: string;
  reason: string;
  categories: string[];
  expectedMarkers: string[];
  forbiddenMarkers?: string[];
  minimumSpeakerMarkers?: number;
  minimumTableLines?: number;
  minimumRepeatedHeaderLines?: number;
  expectedContentClassification?: PdfPagePlan["contentClassification"];
}

export interface PdfGoldenResult {
  id: string;
  sourcePath: string;
  pageNumber: number;
  passed: boolean;
  checks: Record<string, boolean>;
  failures: string[];
}

export interface PdfQualityReport {
  extractorVersion: string;
  chunkerVersion: string;
  summary: PdfNormalizationPlan["summary"];
  golden: {
    fixtures: number;
    passed: number;
    passRate: number;
    results: PdfGoldenResult[];
  };
  distribution: {
    pageTextClasses: Record<string, number>;
    pageContentClassifications: Record<string, number>;
    documentContentClassifications: Record<string, number>;
    extractionMethods: Record<string, number>;
    flagCounts: Record<string, number>;
    percentiles: Record<string, Record<string, number>>;
  };
  severeRegressionCriteria: Record<string, number | string>;
  severeRegressions: string[];
}

export async function loadPdfGoldenFixtures(): Promise<PdfGoldenFixture[]> {
  return JSON.parse(
    await readFile(
      resolve(repositoryRoot, "pipelines/test-fixtures/pdf-golden.json"),
      "utf8"
    )
  ) as PdfGoldenFixture[];
}

function pageForFixture(
  plan: PdfNormalizationPlan,
  fixture: PdfGoldenFixture
): PdfPagePlan | undefined {
  return plan.pages.find(
    (page) =>
      page.sourcePath === fixture.sourcePath &&
      page.pageNumber === fixture.pageNumber
  );
}

export function evaluateGoldenFixtures(
  plan: PdfNormalizationPlan,
  catalog: CatalogEntry[],
  fixtures: PdfGoldenFixture[]
): PdfGoldenResult[] {
  return fixtures.map((fixture) => {
    const source = catalog.find((entry) => entry.path === fixture.sourcePath);
    const page = pageForFixture(plan, fixture);
    const checks: Record<string, boolean> = {
      sourcePresent: source !== undefined,
      sourceSha256: source?.sha256 === fixture.sourceSha256,
      pagePresent: page !== undefined,
      rawTextSha256: page?.rawContentSha256 === fixture.rawTextSha256,
      expectedMarkers:
        page !== undefined &&
        fixture.expectedMarkers.every((marker) => page.text.includes(marker)),
      forbiddenMarkers:
        page !== undefined &&
        (fixture.forbiddenMarkers ?? []).every(
          (marker) => !page.text.includes(marker)
        ),
      speakerMarkers:
        page !== undefined &&
        page.quality.speakerMarkerCount >=
          (fixture.minimumSpeakerMarkers ?? 0),
      tableLines:
        page !== undefined &&
        page.quality.likelyTableLineCount >= (fixture.minimumTableLines ?? 0),
      repeatedHeaders:
        page !== undefined &&
        page.quality.repeatedHeaderLineCount >=
          (fixture.minimumRepeatedHeaderLines ?? 0),
      contentClassification:
        page !== undefined &&
        (fixture.expectedContentClassification === undefined ||
          page.contentClassification === fixture.expectedContentClassification)
    };
    const failures = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    return {
      id: fixture.id,
      sourcePath: fixture.sourcePath,
      pageNumber: fixture.pageNumber,
      passed: failures.length === 0,
      checks,
      failures
    };
  });
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  );
  return Number(sorted[index]!.toFixed(6));
}

function percentiles(values: number[]): Record<string, number> {
  return {
    p05: percentile(values, 0.05),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95)
  };
}

export function buildPdfQualityReport(
  plan: PdfNormalizationPlan,
  catalog: CatalogEntry[],
  fixtures: PdfGoldenFixture[]
): PdfQualityReport {
  const goldenResults = evaluateGoldenFixtures(plan, catalog, fixtures);
  const goldenPassed = goldenResults.filter((result) => result.passed).length;
  const pageTextClasses: Record<string, number> = {};
  const pageContentClassifications: Record<string, number> = {};
  const documentContentClassifications: Record<string, number> = {};
  const extractionMethods: Record<string, number> = {};
  const flagCounts: Record<string, number> = {};
  for (const page of plan.pages) {
    pageTextClasses[page.quality.textClass] =
      (pageTextClasses[page.quality.textClass] ?? 0) + 1;
    pageContentClassifications[page.contentClassification] =
      (pageContentClassifications[page.contentClassification] ?? 0) + 1;
    extractionMethods[page.extractionMethod] =
      (extractionMethods[page.extractionMethod] ?? 0) + 1;
    for (const flag of page.quality.flags) {
      flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
    }
  }
  for (const document of plan.documents) {
    documentContentClassifications[document.contentClassification] =
      (documentContentClassifications[document.contentClassification] ?? 0) + 1;
  }
  const maximumFailedPages = Math.max(1, Math.ceil(plan.summary.pages * 0.01));
  const excludedPageIds = new Set(
    plan.pages
      .filter((page) => page.contentClassification !== "extracted_ok")
      .map((page) => page.pageId)
  );
  const excludedPageNumbers = new Set(
    plan.pages
      .filter((page) => excludedPageIds.has(page.pageId))
      .map((page) => `${page.documentId}:${page.pageNumber}`)
  );
  const excludedContentChunks = plan.chunks.filter((chunk) =>
    excludedPageNumbers.has(`${chunk.documentId}:${chunk.pageStart}`)
  ).length;
  const invalidPolicyIdentityDocuments = plan.documents.filter(
    (document) =>
      document.documentType === "provincial_work_plan" &&
      document.contentClassification === "extracted_ok" &&
      document.metadata.policyIdentityValidated !== true
  ).length;
  const severeRegressions: string[] = [];
  if (goldenPassed !== goldenResults.length) {
    severeRegressions.push(
      `${goldenResults.length - goldenPassed} golden fixture(s) failed`
    );
  }
  if (plan.summary.failedPages > maximumFailedPages) {
    severeRegressions.push(
      `${plan.summary.failedPages} failed pages exceeded ${maximumFailedPages}`
    );
  }
  if (excludedContentChunks > 0) {
    severeRegressions.push(
      `${excludedContentChunks} chunk(s) were created from excluded pages`
    );
  }
  if (invalidPolicyIdentityDocuments > 0) {
    severeRegressions.push(
      `${invalidPolicyIdentityDocuments} extracted policy document(s) lacked validated type/year evidence`
    );
  }
  return {
    extractorVersion: PDF_EXTRACTOR_VERSION,
    chunkerVersion: PDF_CHUNKER_VERSION,
    summary: plan.summary,
    golden: {
      fixtures: goldenResults.length,
      passed: goldenPassed,
      passRate:
        goldenResults.length === 0 ? 0 : goldenPassed / goldenResults.length,
      results: goldenResults
    },
    distribution: {
      pageTextClasses,
      pageContentClassifications,
      documentContentClassifications,
      extractionMethods,
      flagCounts,
      percentiles: {
        nonWhitespaceCharacterCount: percentiles(
          plan.pages.map(
            (page) => page.quality.nonWhitespaceCharacterCount
          )
        ),
        hangulRatio: percentiles(
          plan.pages.map((page) => page.quality.hangulRatio)
        ),
        mojibakeScore: percentiles(
          plan.pages.map((page) => page.quality.mojibakeScore)
        ),
        administrativeTermHitRate: percentiles(
          plan.pages.map((page) => page.quality.administrativeTermHitRate)
        ),
        replacementControlGlyphRatio: percentiles(
          plan.pages.map(
            (page) => page.quality.replacementControlGlyphRatio
          )
        ),
        suspiciousSpacingRatio: percentiles(
          plan.pages.map((page) => page.quality.suspiciousSpacingRatio)
        ),
        likelyTableDensity: percentiles(
          plan.pages.map((page) => page.quality.likelyTableDensity)
        ),
        speakerMarkerCount: percentiles(
          plan.pages.map((page) => page.quality.speakerMarkerCount)
        )
      }
    },
    severeRegressionCriteria: {
      goldenPassRate: "100%",
      maximumFailedPages,
      excludedContentChunks: 0,
      invalidPolicyIdentityDocuments: 0
    },
    severeRegressions
  };
}
