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
          (fixture.minimumRepeatedHeaderLines ?? 0)
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
  const flagCounts: Record<string, number> = {};
  for (const page of plan.pages) {
    pageTextClasses[page.quality.textClass] =
      (pageTextClasses[page.quality.textClass] ?? 0) + 1;
    for (const flag of page.quality.flags) {
      flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
    }
  }
  const maximumFailedPages = Math.max(1, Math.ceil(plan.summary.pages * 0.01));
  const maximumOcrRequiredPages = Math.max(
    1,
    Math.ceil(plan.summary.pages * 0.02)
  );
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
  if (plan.summary.ocrRequiredPages > maximumOcrRequiredPages) {
    severeRegressions.push(
      `${plan.summary.ocrRequiredPages} OCR-required pages exceeded ${maximumOcrRequiredPages}`
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
      maximumOcrRequiredPages
    },
    severeRegressions
  };
}
