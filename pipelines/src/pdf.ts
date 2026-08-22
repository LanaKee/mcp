import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { CatalogEntry } from "./catalog.js";
import { repositoryRoot } from "./etl.js";
import {
  classifyDocumentKoreanText,
  classifyPageKoreanText,
  scoreKoreanTextPlausibility,
  type KoreanTextPlausibility,
  type PdfContentClassification
} from "./korean-text-quality.js";
import { officialSourceKey, type PlannedLocator, type PlannedSource } from "./load-plan.js";
import { resolveGyeongbukRegion } from "./regions.js";

export type PdfExtractionMethod = "native_pdf_text" | "none";

export type PdfExtractionStatus =
  | "extracted"
  | "partial"
  | "unusable_for_retrieval"
  | "extraction_failed"
  | "password_required";

export interface ExtractedPdfPage {
  pageNumber: number;
  rawText: string;
  rawContentSha256: string;
  status:
    | "extracted"
    | "unusable_for_retrieval"
    | "empty"
    | "extraction_failed";
  hasVisualContent: boolean;
  error: string | null;
}

export type PdfPageTextClass = "empty" | "near_empty" | "substantive";

export interface PdfPageQuality {
  nonWhitespaceCharacterCount: number;
  hangulRatio: number;
  replacementControlGlyphRatio: number;
  suspiciousSpacingRatio: number;
  repeatedHeaderLineCount: number;
  repeatedFooterLineCount: number;
  likelyTableLineCount: number;
  likelyTableDensity: number;
  speakerMarkerCount: number;
  hangulCharacterCount: number;
  administrativeTermHitRate: number;
  validHangulBigramRatio: number;
  rareHangulSyllableRatio: number;
  particleTokenRatio: number;
  whitespaceBoundaryRatio: number;
  digitPunctuationRatio: number;
  mojibakeScore: number;
  textClass: PdfPageTextClass;
  flags: string[];
}

export interface PdfPagePlan {
  pageId: string;
  pageKey: string;
  documentId: string;
  sourceKey: string;
  sourcePath: string;
  pageNumber: number;
  extractionStatus:
    | "extracted"
    | "unusable_for_retrieval"
    | "empty"
    | "extraction_failed";
  contentClassification: PdfContentClassification;
  extractionMethod: PdfExtractionMethod;
  rawContentSha256: string;
  contentSha256: string;
  text: string;
  error: string | null;
  extractorVersion: string;
  quality: PdfPageQuality;
  metadata: Record<string, unknown>;
}

export interface PdfDocumentPlan {
  documentId: string;
  documentKey: string;
  regionId: string | null;
  documentType: string;
  title: string;
  organization: string | null;
  publishedDate: string | null;
  sourceKey: string;
  extractionStatus: PdfExtractionStatus;
  contentClassification: PdfContentClassification;
  extractionMethod: PdfExtractionMethod;
  pageCount: number;
  contentSha256: string;
  dataStatus: "official_observed" | "catalog_only";
  metadata: Record<string, unknown>;
}

export interface PdfChunkPlan {
  chunkId: string;
  chunkKey: string;
  documentId: string;
  chunkIndex: number;
  pageStart: number;
  pageEnd: number;
  sectionTitle: string | null;
  content: string;
  contentSha256: string;
  tokenCount: number;
  metadata: Record<string, unknown>;
}

export interface PdfNormalizationFailure {
  sourcePath: string;
  status: PdfExtractionStatus;
  error: string;
}

export interface PdfNormalizationPlan {
  sources: PlannedSource[];
  documents: PdfDocumentPlan[];
  pages: PdfPagePlan[];
  chunks: PdfChunkPlan[];
  locators: PlannedLocator[];
  failures: PdfNormalizationFailure[];
  summary: {
    files: number;
    pages: number;
    extractedPages: number;
    unusableForRetrievalPages: number;
    mojibakeSuspectedPages: number;
    classifiedEmptyPages: number;
    failedPages: number;
    emptyPages: number;
    nearEmptyPages: number;
    tableLikelyPages: number;
    speakerRichPages: number;
    repeatedHeaderLinesRemoved: number;
    repeatedFooterLinesRemoved: number;
    chunks: number;
    extractedDocuments: number;
    partialDocuments: number;
    unusableForRetrievalDocuments: number;
    mojibakeSuspectedDocuments: number;
    emptyDocuments: number;
    failedDocuments: number;
  };
}

export interface PdfChunkingOptions {
  maxChars?: number;
  overlapChars?: number;
}

export const PDF_EXTRACTOR_VERSION = "pdfjs-6.2.108-layout-v3-mojibake";
export const PDF_CHUNKER_VERSION = "korean-document-v4-quality-gated";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function deterministicUuid(value: string): string {
  const hex = sha256(value).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8).join(""),
    hex.slice(8, 12).join(""),
    hex.slice(12, 16).join(""),
    hex.slice(16, 20).join(""),
    hex.slice(20, 32).join("")
  ].join("-");
}

export function normalizeExtractedText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\u00a0/gu, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .split(/\r?\n/u)
    .map((line) =>
      line
        .split(/\t+/u)
        .map((cell) => cell.replace(/ +/gu, " ").trim())
        .filter(Boolean)
        .join("\t")
    )
    .filter((line) => !isDecorativeOnlyLine(line))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

export function classifyPdfExtractionError(error: unknown): {
  status: "password_required" | "extraction_failed";
  error: string;
} {
  const name = error instanceof Error ? error.name : "";
  const message = safeError(error);
  if (name === "PasswordException" || /password|encrypted/iu.test(message)) {
    return { status: "password_required", error: message };
  }
  return { status: "extraction_failed", error: message };
}

export function extractionStatusForPages(
  pages: ExtractedPdfPage[]
): PdfExtractionStatus {
  const extracted = pages.filter((page) => page.status === "extracted").length;
  const failed = pages.filter((page) => page.status === "extraction_failed").length;
  const unusable = pages.filter(
    (page) => page.status === "unusable_for_retrieval"
  ).length;
  const empty = pages.filter((page) => page.status === "empty").length;
  if (extracted === 0) {
    if (unusable > 0) return "unusable_for_retrieval";
    return failed > 0
      ? "extraction_failed"
      : empty > 0
        ? "extracted"
        : "unusable_for_retrieval";
  }
  return failed > 0 || unusable > 0 ? "partial" : "extracted";
}

function appendItem(line: string, item: string, separator = " "): string {
  if (!line) return item;
  if (/^[,.;:!?%)\]}]/u.test(item) || /[(\[{]$/u.test(line)) return `${line}${item}`;
  return `${line}${separator}${item}`;
}

function pageTextFromItems(items: unknown[]): string {
  const lines: string[] = [];
  let line = "";
  let previousY: number | null = null;
  let previousX: number | null = null;
  let previousWidth = 0;
  for (const raw of items) {
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("str" in raw) ||
      typeof raw.str !== "string"
    ) {
      continue;
    }
    const item = raw as {
      str: string;
      hasEOL?: boolean;
      transform?: number[];
      height?: number;
      width?: number;
    };
    const text = item.str.replace(/\s+/gu, " ").trim();
    const y = item.transform?.[5];
    const x = item.transform?.[4];
    const threshold = Math.max(2, (item.height ?? 8) * 0.45);
    if (
      line &&
      typeof y === "number" &&
      previousY !== null &&
      Math.abs(y - previousY) > threshold
    ) {
      lines.push(line);
      line = "";
      previousX = null;
      previousWidth = 0;
    }
    if (text) {
      const gap =
        typeof x === "number" && previousX !== null
          ? x - (previousX + previousWidth)
          : 0;
      const columnGap = Math.max(18, (item.height ?? 8) * 1.8);
      line = appendItem(line, text, gap > columnGap ? "\t" : " ");
    }
    if (item.hasEOL && line) {
      lines.push(line);
      line = "";
      previousX = null;
      previousWidth = 0;
    }
    if (typeof y === "number") previousY = y;
    if (typeof x === "number") previousX = x;
    previousWidth = item.width ?? 0;
  }
  if (line) lines.push(line);
  return lines.join("\n").normalize("NFC").trim();
}

export async function extractPdfPages(buffer: Buffer): Promise<{
  pageCount: number;
  pages: ExtractedPdfPage[];
}> {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false
  });
  try {
    const pdf = await loadingTask.promise;
    const pages: ExtractedPdfPage[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      try {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const rawText = pageTextFromItems(content.items);
        const text = normalizeExtractedText(rawText);
        let hasVisualContent = false;
        if (!text) {
          const operators = await page.getOperatorList();
          hasVisualContent = operators.fnArray.some((operator) =>
            [
              OPS.paintImageXObject,
              OPS.paintInlineImageXObject,
              OPS.paintImageMaskXObject,
              OPS.paintSolidColorImageMask
            ].includes(operator)
          );
        }
        pages.push({
          pageNumber,
          rawText,
          rawContentSha256: sha256(rawText),
          status: text
            ? "extracted"
            : hasVisualContent
              ? "unusable_for_retrieval"
              : "empty",
          hasVisualContent,
          error: null
        });
        page.cleanup();
      } catch (error) {
        pages.push({
          pageNumber,
          rawText: "",
          rawContentSha256: sha256(""),
          status: "extraction_failed",
          hasVisualContent: false,
          error: safeError(error)
        });
      }
    }
    return { pageCount: pdf.numPages, pages };
  } finally {
    await loadingTask.destroy();
  }
}

function isDecorativeOnlyLine(line: string): boolean {
  const compact = line.replace(/\s/gu, "");
  return (
    compact.length >= 4 &&
    !/[\p{L}\p{N}]/u.test(compact) &&
    /^[\p{P}\p{S}\p{Co}]+$/u.test(compact)
  );
}

function marginPattern(line: string): string {
  return line
    .normalize("NFC")
    .replace(/\d+/gu, "#")
    .replace(/\s+/gu, " ")
    .trim();
}

function canBeRepeatedMargin(line: string): boolean {
  const pattern = marginPattern(line);
  return (
    pattern.length >= 5 &&
    pattern.length <= 100 &&
    /[\p{L}\p{N}]/u.test(pattern) &&
    !/^다음\s*#\s*쪽입니다[.]?$/u.test(pattern) &&
    !/(?:다|요|함|임)[.!?]?$/u.test(pattern) &&
    (pattern.includes("#") || /(?:의회|위원회|회의록|감사)$/u.test(pattern))
  );
}

export interface RepeatedMarginPatterns {
  headers: Set<string>;
  footers: Set<string>;
}

export function detectRepeatedMarginPatterns(
  pages: ExtractedPdfPage[]
): RepeatedMarginPatterns {
  const counts = {
    headers: new Map<string, Set<number>>(),
    footers: new Map<string, Set<number>>()
  };
  for (const page of pages) {
    const lines = normalizeExtractedText(page.rawText).split("\n").filter(Boolean);
    for (const [zone, candidates] of [
      ["headers", lines.slice(0, 3)],
      ["footers", lines.slice(-3)]
    ] as const) {
      for (const line of candidates) {
        if (!canBeRepeatedMargin(line)) continue;
        const pattern = marginPattern(line);
        const pageNumbers = counts[zone].get(pattern) ?? new Set<number>();
        pageNumbers.add(page.pageNumber);
        counts[zone].set(pattern, pageNumbers);
      }
    }
  }
  const minimum = Math.max(3, Math.ceil(pages.length * 0.5));
  const selected = (values: Map<string, Set<number>>) =>
    new Set(
      [...values.entries()]
        .filter(([, pageNumbers]) => pageNumbers.size >= minimum)
        .map(([pattern]) => pattern)
    );
  return {
    headers: pages.length >= 4 ? selected(counts.headers) : new Set(),
    footers: pages.length >= 4 ? selected(counts.footers) : new Set()
  };
}

function removeRepeatedMargins(
  text: string,
  patterns: RepeatedMarginPatterns
): {
  text: string;
  repeatedHeaderLineCount: number;
  repeatedFooterLineCount: number;
  removedLineHashes: Array<{ zone: "header" | "footer"; sha256: string }>;
} {
  const lines = text.split("\n");
  const removed = new Set<number>();
  const removedLineHashes: Array<{
    zone: "header" | "footer";
    sha256: string;
  }> = [];
  let repeatedHeaderLineCount = 0;
  let repeatedFooterLineCount = 0;
  for (const index of lines.slice(0, 3).keys()) {
    const line = lines[index]!;
    if (patterns.headers.has(marginPattern(line))) {
      removed.add(index);
      repeatedHeaderLineCount += 1;
      removedLineHashes.push({ zone: "header", sha256: sha256(line) });
    }
  }
  const footerStart = Math.max(0, lines.length - 3);
  for (let index = footerStart; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!removed.has(index) && patterns.footers.has(marginPattern(line))) {
      removed.add(index);
      repeatedFooterLineCount += 1;
      removedLineHashes.push({ zone: "footer", sha256: sha256(line) });
    }
  }
  return {
    text: lines.filter((_, index) => !removed.has(index)).join("\n").trim(),
    repeatedHeaderLineCount,
    repeatedFooterLineCount,
    removedLineHashes
  };
}

export function isSpeakerMarkerLine(line: string): boolean {
  return /^○\s*[가-힣A-Za-z]/u.test(line.trim());
}

export function isLikelyTableLine(line: string): boolean {
  const value = line.trim();
  if (!value) return false;
  if (value.split("\t").filter(Boolean).length >= 3) return true;
  if (/[-─━.·]{5,}/u.test(value) && /[\p{L}\p{N}]/u.test(value)) return true;
  if (/[│┃|┼┬┴├┤]/u.test(value)) return true;
  const numericCells = value.match(/(?:^|\s)[+-]?\d[\d,.%]*(?=\s|$)/gu) ?? [];
  return value.length >= 20 && numericCells.length >= 3;
}

function suspiciousSpacingCount(text: string): number {
  return text.split(/\r?\n/u).reduce((total, line) => {
    const tokens = line.trim().split(/ +/u).filter(Boolean);
    if (tokens.length < 4) return total;
    const singleHangul = tokens.filter((token) => /^[가-힣]$/u.test(token)).length;
    return total + (singleHangul / tokens.length >= 0.6 ? singleHangul - 1 : 0);
  }, 0);
}

export function scorePdfPageQuality(
  rawText: string,
  cleanedText: string,
  repeatedHeaderLineCount = 0,
  repeatedFooterLineCount = 0,
  plausibility: KoreanTextPlausibility = scoreKoreanTextPlausibility(cleanedText)
): PdfPageQuality {
  const nonWhitespaceCharacterCount = [...cleanedText].filter(
    (character) => !/\s/u.test(character)
  ).length;
  const rawNonWhitespace = [...rawText].filter(
    (character) => !/\s/u.test(character)
  );
  const hangulCount = [...cleanedText].filter((character) =>
    /[가-힣ㄱ-ㅎㅏ-ㅣ]/u.test(character)
  ).length;
  const replacementControlCount = rawNonWhitespace.filter((character) =>
    /[\u0000-\u001f\u007f-\u009f\uFFFD\uE000-\uF8FF]/u.test(character)
  ).length;
  const lines = cleanedText.split("\n").filter(Boolean);
  const likelyTableLineCount = lines.filter(isLikelyTableLine).length;
  const speakerMarkerCount = lines.filter(isSpeakerMarkerLine).length;
  const suspiciousCount = suspiciousSpacingCount(rawText);
  const textClass: PdfPageTextClass =
    nonWhitespaceCharacterCount === 0
      ? "empty"
      : nonWhitespaceCharacterCount < 80
        ? "near_empty"
        : "substantive";
  const hangulRatio =
    nonWhitespaceCharacterCount === 0
      ? 0
      : hangulCount / nonWhitespaceCharacterCount;
  const replacementControlGlyphRatio =
    rawNonWhitespace.length === 0
      ? 0
      : replacementControlCount / rawNonWhitespace.length;
  const suspiciousSpacingRatio =
    nonWhitespaceCharacterCount === 0
      ? 0
      : suspiciousCount / nonWhitespaceCharacterCount;
  const likelyTableDensity =
    lines.length === 0 ? 0 : likelyTableLineCount / lines.length;
  const flags: string[] = [];
  if (textClass !== "substantive") flags.push(textClass);
  if (hangulRatio < 0.2 && nonWhitespaceCharacterCount >= 80) {
    flags.push("low_hangul_ratio");
  }
  if (replacementControlGlyphRatio > 0.01) flags.push("control_glyphs");
  if (suspiciousSpacingRatio > 0.03) flags.push("suspicious_spacing");
  if (plausibility.mojibakeScore >= 0.72) flags.push("low_korean_plausibility");
  if (likelyTableLineCount >= 3 && likelyTableDensity >= 0.1) {
    flags.push("table_likely");
  }
  if (speakerMarkerCount >= 5) flags.push("speaker_rich");
  if (repeatedHeaderLineCount + repeatedFooterLineCount > 0) {
    flags.push("repeated_margin_removed");
  }
  return {
    nonWhitespaceCharacterCount,
    hangulRatio,
    replacementControlGlyphRatio,
    suspiciousSpacingRatio,
    repeatedHeaderLineCount,
    repeatedFooterLineCount,
    likelyTableLineCount,
    likelyTableDensity,
    speakerMarkerCount,
    hangulCharacterCount: plausibility.hangulCharacterCount,
    administrativeTermHitRate: plausibility.administrativeTermHitRate,
    validHangulBigramRatio: plausibility.validHangulBigramRatio,
    rareHangulSyllableRatio: plausibility.rareHangulSyllableRatio,
    particleTokenRatio: plausibility.particleTokenRatio,
    whitespaceBoundaryRatio: plausibility.whitespaceBoundaryRatio,
    digitPunctuationRatio: plausibility.digitPunctuationRatio,
    mojibakeScore: plausibility.mojibakeScore,
    textClass,
    flags
  };
}

export function normalizePdfPages(
  documentKey: string,
  documentId: string,
  sourceKey: string,
  sourcePath: string,
  pages: ExtractedPdfPage[],
  documentClassification?: PdfContentClassification
): PdfPagePlan[] {
  const aggregateClassification =
    documentClassification ??
    classifyDocumentKoreanText(
      pages.map((page) => page.rawText).join("\n"),
      pages.some((page) => page.hasVisualContent)
    ).classification;
  const patterns = detectRepeatedMarginPatterns(pages);
  return pages.map((page) => {
    const normalized = normalizeExtractedText(page.rawText);
    const cleaned = removeRepeatedMargins(normalized, patterns);
    const extractedText = normalizeExtractedText(cleaned.text);
    const classified =
      page.status === "extraction_failed"
        ? {
            classification: "empty" as const,
            evidence: scoreKoreanTextPlausibility("")
          }
        : classifyPageKoreanText(
            extractedText,
            page.hasVisualContent,
            aggregateClassification
          );
    const contentClassification =
      page.status === "extraction_failed"
        ? "empty"
        : classified.classification;
    const text =
      contentClassification === "extracted_ok" ? extractedText : "";
    const extractionMethod: PdfExtractionMethod =
      contentClassification === "extracted_ok" ? "native_pdf_text" : "none";
    const pageKey = `${documentKey}:${PDF_EXTRACTOR_VERSION}:page:${page.pageNumber}`;
    const flags = [...classified.evidence.signals];
    if (contentClassification !== "extracted_ok") {
      flags.push(contentClassification);
    }
    const quality = scorePdfPageQuality(
      page.rawText,
      extractedText,
      cleaned.repeatedHeaderLineCount,
      cleaned.repeatedFooterLineCount,
      classified.evidence
    );
    quality.flags = [...new Set([...quality.flags, ...flags])];
    return {
      pageId: deterministicUuid(pageKey),
      pageKey,
      documentId,
      sourceKey,
      sourcePath,
      pageNumber: page.pageNumber,
      extractionStatus: page.status,
      contentClassification,
      extractionMethod,
      rawContentSha256: page.rawContentSha256,
      contentSha256: sha256(text),
      text,
      error: page.error,
      extractorVersion: PDF_EXTRACTOR_VERSION,
      quality,
      metadata: {
        removedMarginLineHashes: cleaned.removedLineHashes,
        contentClassification,
        extractionMethod,
        hasVisualContent: page.hasVisualContent,
        koreanTextPlausibility: classified.evidence
      }
    };
  });
}

function isHeading(line: string): boolean {
  return (
    line.length <= 80 &&
    (/^[제\d]+[호장절항]/u.test(line) ||
      /^\[[^\]]+\]$/u.test(line) ||
      /(?:위원회|회의록|감사|보고|질의|답변)$/u.test(line))
  );
}

type SemanticSegmentType = "heading" | "prose" | "speaker" | "table";

interface SemanticSegment {
  text: string;
  type: SemanticSegmentType;
}

function semanticSegments(text: string): SemanticSegment[] {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const segments: SemanticSegment[] = [];
  let current: string[] = [];
  let currentType: SemanticSegmentType = "prose";
  const flush = () => {
    if (current.length > 0) {
      segments.push({
        text: currentType === "table" ? current.join("\n").trim() : current.join(" ").trim(),
        type: currentType
      });
    }
    current = [];
  };
  for (const line of lines) {
    if (isSpeakerMarkerLine(line)) {
      flush();
      currentType = "speaker";
      current.push(line);
      continue;
    }
    if (isLikelyTableLine(line)) {
      if (current.length > 0 && currentType !== "table") flush();
      currentType = "table";
      current.push(line);
      continue;
    }
    if (isHeading(line)) {
      flush();
      segments.push({ text: line, type: "heading" });
      currentType = "prose";
      continue;
    }
    if (current.length > 0 && currentType === "table") flush();
    if (current.length === 0) currentType = "prose";
    current.push(line);
    if (currentType === "speaker") continue;
    if (
      /(?:[.!?。！？]|다\.?|임\.?|함\.?|음\.?)$/u.test(line) ||
      current.join(" ").length >= 500
    ) {
      flush();
    }
  }
  flush();
  return segments;
}

function splitLongSegment(segment: SemanticSegment, maxChars: number): SemanticSegment[] {
  if (segment.text.length <= maxChars) return [segment];
  if (segment.type === "table") {
    const results: SemanticSegment[] = [];
    let current: string[] = [];
    for (const line of segment.text.split("\n")) {
      if (current.length > 0 && [...current, line].join("\n").length > maxChars) {
        results.push({ text: current.join("\n"), type: "table" });
        current = [];
      }
      if (line.length > maxChars) {
        if (current.length > 0) {
          results.push({ text: current.join("\n"), type: "table" });
          current = [];
        }
        for (let index = 0; index < line.length; index += maxChars) {
          results.push({
            text: line.slice(index, index + maxChars).trim(),
            type: "table"
          });
        }
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) results.push({ text: current.join("\n"), type: "table" });
    return results.filter((item) => item.text);
  }
  const sentences = segment.text
    .split(/(?<=[.!?。！？])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const results: SemanticSegment[] = [];
  let current = "";
  for (const sentence of sentences.length > 1 ? sentences : [segment.text]) {
    if (sentence.length > maxChars) {
      if (current) results.push({ text: current, type: segment.type });
      current = "";
      for (let index = 0; index < sentence.length; index += maxChars) {
        results.push({
          text: sentence.slice(index, index + maxChars).trim(),
          type: segment.type
        });
      }
    } else if (!current) {
      current = sentence;
    } else if (current.length + sentence.length + 1 <= maxChars) {
      current = `${current} ${sentence}`;
    } else {
      results.push({ text: current, type: segment.type });
      current = sentence;
    }
  }
  if (current) results.push({ text: current, type: segment.type });
  return results.filter((item) => item.text);
}

function overlapSegments(
  segments: SemanticSegment[],
  overlapChars: number
): SemanticSegment[] {
  const overlap: SemanticSegment[] = [];
  let length = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    if (
      segment.type === "speaker" ||
      segment.type === "table" ||
      (overlap.length > 0 && length + segment.text.length > overlapChars)
    ) {
      break;
    }
    overlap.unshift(segment);
    length += segment.text.length;
  }
  return overlap;
}

export function chunkPdfPages(
  documentKey: string,
  documentId: string,
  pages: PdfPagePlan[],
  options: PdfChunkingOptions = {}
): PdfChunkPlan[] {
  const maxChars = options.maxChars ?? 1200;
  const overlapChars = Math.min(options.overlapChars ?? 160, Math.floor(maxChars / 3));
  const chunks: PdfChunkPlan[] = [];
  let chunkIndex = 0;

  for (const page of pages) {
    if (page.contentClassification !== "extracted_ok" || !page.text) continue;
    const segments = semanticSegments(page.text).flatMap((segment) =>
      splitLongSegment(segment, maxChars)
    );
    let current: SemanticSegment[] = [];
    let overlapCount = 0;
    let pageChunkIndex = 0;
    const flush = () => {
      const content = current.map((segment) => segment.text).join("\n\n").trim();
      if (!content) return;
      const chunkKey = `${documentKey}:${PDF_CHUNKER_VERSION}:page:${page.pageNumber}:chunk:${pageChunkIndex}`;
      const contentSha256 = sha256(content);
      const segmentTypes = [...new Set(current.map((segment) => segment.type))];
      chunks.push({
        chunkId: deterministicUuid(chunkKey),
        chunkKey,
        documentId,
        chunkIndex,
        pageStart: page.pageNumber,
        pageEnd: page.pageNumber,
        sectionTitle:
          current[0]?.type === "heading" ? current[0].text.slice(0, 200) : null,
        content,
        contentSha256,
        tokenCount: content.split(/\s+/u).filter(Boolean).length,
        metadata: {
          pageChunkIndex,
          overlapChars,
          appliedOverlapSegmentCount: overlapCount,
          extractionPageSha256: page.contentSha256,
          rawExtractionPageSha256: page.rawContentSha256,
          extractorVersion: PDF_EXTRACTOR_VERSION,
          chunkerVersion: PDF_CHUNKER_VERSION,
          extractionMethod: page.extractionMethod,
          contentClassification: page.contentClassification,
          segmentTypes
        }
      });
      chunkIndex += 1;
      pageChunkIndex += 1;
      overlapCount = 0;
    };

    for (const segment of segments) {
      if (segment.type === "table") {
        flush();
        current = [segment];
        flush();
        current = [];
        continue;
      }
      if (segment.type === "speaker") {
        if (current.some((item) => item.type !== "speaker")) {
          flush();
          current = [];
        }
        const nextLength = [...current, segment]
          .map((item) => item.text)
          .join("\n\n").length;
        if (current.length > 0 && nextLength > maxChars) {
          flush();
          current = [];
        }
        current.push(segment);
        continue;
      }
      if (current.some((item) => item.type === "speaker")) {
        flush();
        current = [];
      }
      const nextLength = [...current, segment]
        .map((item) => item.text)
        .join("\n\n").length;
      if (current.length > 0 && nextLength > maxChars) {
        const previous = current;
        flush();
        current = overlapSegments(previous, overlapChars);
        overlapCount = current.length;
        while (
          current.length > 0 &&
          [...current, segment].map((item) => item.text).join("\n\n").length >
            maxChars
        ) {
          current.shift();
          overlapCount = current.length;
        }
      }
      const newContentHash = sha256(segment.text);
      if (current.some((item) => sha256(item.text) === newContentHash)) {
        current = [];
        overlapCount = 0;
      }
      current.push(segment);
    }
    flush();
  }
  return chunks;
}

interface PdfDocumentIdentity {
  documentType: string;
  title: string;
  organization: string | null;
  regionId: string | null;
  publishedDate: string | null;
  policyYear: number | null;
  typeEvidence: "content_validated" | "filename_candidate" | "council_path";
  yearEvidence: string | null;
}

function policyYearFromPath(path: string): number | null {
  const match = path.normalize("NFC").match(
    /(?:^|\/)dojeong_((?:19|20)\d{2})\.pdf$/u
  );
  return match ? Number(match[1]) : null;
}

function documentIdentity(
  entry: CatalogEntry,
  extractedText = "",
  contentClassification: PdfContentClassification = "empty"
): PdfDocumentIdentity {
  const policyYear = policyYearFromPath(entry.path);
  if (policyYear !== null) {
    const normalizedText = extractedText.normalize("NFC");
    const hasWorkPlanMarker =
      /업무\s*계획/u.test(normalizedText) ||
      /도정.{0,20}(?:계획|방향|운영)/u.test(normalizedText);
    const yearMatch = normalizedText.match(/(20\d{2})\s*(?:년도|년)/u);
    const yearEvidence = yearMatch?.[1] ?? null;
    const contentValidated =
      contentClassification === "extracted_ok" &&
      hasWorkPlanMarker &&
      yearEvidence === String(policyYear);
    return {
      documentType: "provincial_work_plan",
      title: `${policyYear}년도 경상북도 도정 업무계획`,
      organization: "경상북도",
      regionId: "47",
      publishedDate: `${policyYear}-01-01`,
      policyYear,
      typeEvidence: contentValidated
        ? "content_validated"
        : "filename_candidate",
      yearEvidence
    };
  }
  const normalized = entry.path.normalize("NFC");
  const region = resolveGyeongbukRegion(entry.path);
  return {
    documentType: normalized.includes("행정사무감사")
      ? "council_audit_minutes"
      : "council_minutes",
    title: entry.fileNameNfc.slice(0, -extname(entry.fileNameNfc).length),
    organization: region
      ? region.regionType === "province"
        ? "경상북도의회"
        : `${region.regionName}의회`
      : null,
    regionId: region?.regionId ?? null,
    publishedDate: entry.referenceDate,
    policyYear: null,
    typeEvidence: "council_path",
    yearEvidence: null
  };
}

function sourceFromCatalog(entry: CatalogEntry): PlannedSource {
  const policyYear = policyYearFromPath(entry.path);
  return {
    sourceKey: officialSourceKey(entry.sha256),
    title: entry.fileNameNfc,
    provider:
      policyYear !== null
        ? "경상북도"
        : resolveGyeongbukRegion(entry.path)?.regionName ?? "공공데이터 원천",
    sourceUrl: null,
    licenseNote: null,
    filePath: entry.path,
    fileSha256: entry.sha256,
    collectedAt: entry.collectedAt,
    referenceDate: policyYear !== null ? `${policyYear}-01-01` : entry.referenceDate,
    mediaType: entry.mediaType,
    dataStatus: "catalog_only",
    isOfficial: true,
    metadata: {
      byteSize: entry.byteSize,
      contentKind: entry.contentKind,
      parseStatus: entry.parseStatus,
      documentTypeCandidate:
        policyYear !== null ? "provincial_work_plan" : null,
      policyYearCandidate: policyYear
    }
  };
}

async function normalizePdf(entry: CatalogEntry): Promise<{
  source: PlannedSource;
  document: PdfDocumentPlan;
  pagePlans: PdfPagePlan[];
  chunks: PdfChunkPlan[];
  locators: PlannedLocator[];
  failure: PdfNormalizationFailure | null;
}> {
  const source = sourceFromCatalog(entry);
  const documentKey = `document-${sha256(source.sourceKey).slice(0, 48)}`;
  const documentId = deterministicUuid(documentKey);
  const initialIdentity = documentIdentity(entry);
  const locators: PlannedLocator[] = [
    {
      sourceKey: source.sourceKey,
      entityType: "document",
      entityKey: documentKey,
      pageNumber: null,
      rowNumber: null,
      sectionName: null,
      characterStart: null,
      characterEnd: null,
      locatorText: entry.path
    }
  ];

  try {
    const extracted = await extractPdfPages(await readFile(resolve(repositoryRoot, entry.path)));
    const normalizedDocumentText = extracted.pages
      .map((page) => normalizeExtractedText(page.rawText))
      .join("\n");
    const documentAssessment = classifyDocumentKoreanText(
      normalizedDocumentText,
      extracted.pages.some((page) => page.hasVisualContent)
    );
    const identity = documentIdentity(
      entry,
      normalizedDocumentText,
      documentAssessment.classification
    );
    source.metadata = {
      ...source.metadata,
      documentType: identity.documentType,
      policyYear: identity.policyYear,
      typeEvidence: identity.typeEvidence,
      yearEvidence: identity.yearEvidence,
      contentClassification: documentAssessment.classification,
      koreanTextPlausibility: documentAssessment.evidence
    };
    const failedPages = extracted.pages.filter(
      (page) => page.status === "extraction_failed"
    );
    const pagePlans = normalizePdfPages(
      documentKey,
      documentId,
      source.sourceKey,
      entry.path,
      extracted.pages,
      documentAssessment.classification
    );
    const extractedPages = pagePlans.filter(
      (page) => page.contentClassification === "extracted_ok"
    );
    const unusablePages = pagePlans.filter(
      (page) => page.contentClassification === "unusable_for_retrieval"
    );
    const mojibakePages = pagePlans.filter(
      (page) => page.contentClassification === "mojibake_suspected"
    );
    const classifiedEmptyPages = pagePlans.filter(
      (page) => page.contentClassification === "empty"
    );
    const contentClassification: PdfContentClassification =
      extractedPages.length > 0
        ? "extracted_ok"
        : mojibakePages.length > 0
          ? "mojibake_suspected"
          : unusablePages.length > 0
            ? "unusable_for_retrieval"
            : "empty";
    const extractionStatus: PdfExtractionStatus =
      extractedPages.length > 0
        ? failedPages.length > 0 ||
          mojibakePages.length > 0
          ? "partial"
          : "extracted"
        : contentClassification === "empty"
          ? "extracted"
          : failedPages.length === pagePlans.length
            ? "extraction_failed"
            : "unusable_for_retrieval";
    const extractionMethod: PdfExtractionMethod =
      extractedPages.length > 0 ? "native_pdf_text" : "none";
    const policyIdentityValidated =
      identity.documentType !== "provincial_work_plan" ||
      contentClassification !== "extracted_ok" ||
      identity.typeEvidence === "content_validated";
    source.dataStatus =
      contentClassification === "extracted_ok" && policyIdentityValidated
        ? "official_observed"
        : "catalog_only";
    const chunks = policyIdentityValidated
      ? chunkPdfPages(documentKey, documentId, pagePlans)
      : [];
    for (const page of pagePlans) {
      locators.push({
        sourceKey: source.sourceKey,
        entityType: "document_page",
        entityKey: page.pageKey,
        pageNumber: page.pageNumber,
        rowNumber: null,
        sectionName: `${page.contentClassification}:${page.extractionMethod}`,
        characterStart: null,
        characterEnd: null,
        locatorText: `${entry.path}#page=${page.pageNumber}`
      });
    }
    for (const chunk of chunks) {
      locators.push({
        sourceKey: source.sourceKey,
        entityType: "document_chunk",
        entityKey: chunk.chunkKey,
        pageNumber: chunk.pageStart,
        rowNumber: null,
        sectionName: chunk.sectionTitle,
        characterStart: null,
        characterEnd: null,
        locatorText: `${entry.path}#page=${chunk.pageStart}`
      });
    }
    const emptyPages = pagePlans.filter(
      (page) => page.quality.textClass === "empty"
    ).length;
    const nearEmptyPages = pagePlans.filter(
      (page) => page.quality.textClass === "near_empty"
    ).length;
    const tableLikelyPages = pagePlans.filter(
      (page) =>
        page.quality.likelyTableLineCount >= 3 &&
        page.quality.likelyTableDensity >= 0.1
    ).length;
    const speakerRichPages = pagePlans.filter(
      (page) => page.quality.speakerMarkerCount >= 5
    ).length;
    const repeatedHeaderLinesRemoved = pagePlans.reduce(
      (total, page) => total + page.quality.repeatedHeaderLineCount,
      0
    );
    const repeatedFooterLinesRemoved = pagePlans.reduce(
      (total, page) => total + page.quality.repeatedFooterLineCount,
      0
    );
    const document: PdfDocumentPlan = {
      documentId,
      documentKey,
      regionId: identity.regionId,
      documentType: identity.documentType,
      title: identity.title,
      organization: identity.organization,
      publishedDate: identity.publishedDate,
      sourceKey: source.sourceKey,
      extractionStatus,
      contentClassification,
      extractionMethod,
      pageCount: extracted.pageCount,
      contentSha256: sha256(
        pagePlans
          .map(
            (page) =>
              `${page.pageNumber}:${page.contentClassification}:${page.contentSha256}`
          )
          .join("\n")
      ),
      dataStatus:
        extractedPages.length > 0 && policyIdentityValidated
          ? "official_observed"
          : "catalog_only",
      metadata: {
        sourcePath: entry.path,
        sourceSha256: entry.sha256,
        extractorVersion: PDF_EXTRACTOR_VERSION,
        chunkerVersion: PDF_CHUNKER_VERSION,
        extractedPages: extractedPages.length,
        unusableForRetrievalPages: unusablePages.map(
          (page) => page.pageNumber
        ),
        mojibakeSuspectedPages: mojibakePages.map((page) => page.pageNumber),
        classifiedEmptyPages: classifiedEmptyPages.map(
          (page) => page.pageNumber
        ),
        failedPages: failedPages.map((page) => ({
          pageNumber: page.pageNumber,
          error: page.error
        })),
        contentClassification,
        extractionMethod,
        documentTypeEvidence: identity.typeEvidence,
        policyYear: identity.policyYear,
        yearEvidence: identity.yearEvidence,
        policyIdentityValidated,
        koreanTextPlausibility: documentAssessment.evidence,
        retrievalExcluded: contentClassification !== "extracted_ok",
        retrievalExclusionReason:
          contentClassification === "mojibake_suspected"
            ? "broken_cmap_mojibake"
            : contentClassification === "unusable_for_retrieval"
              ? "no_usable_text_layer"
              : contentClassification === "empty"
                ? "empty_document"
                : null,
        quality: {
          emptyPages,
          nearEmptyPages,
          tableLikelyPages,
          speakerRichPages,
          repeatedHeaderLinesRemoved,
          repeatedFooterLinesRemoved
        }
      }
    };
    const failure =
      extractionStatus === "extracted" &&
      contentClassification === "extracted_ok" &&
      policyIdentityValidated
        ? null
        : {
            sourcePath: entry.path,
            status: extractionStatus,
            error:
              !policyIdentityValidated
                ? "Policy filename year/type could not be validated against extracted document text"
                : extractionStatus === "partial"
                ? `${failedPages.length} failed pages; ${unusablePages.length} unusable pages; ${mojibakePages.length} mojibake-suspected pages`
                : extractionStatus === "unusable_for_retrieval"
                  ? contentClassification === "mojibake_suspected"
                    ? "Native text is mojibake-suspected; content ingestion was excluded"
                    : "No usable Korean text layer; content ingestion was excluded"
                  : "No usable text was extracted because page extraction failed"
          };
    return {
      source,
      document,
      pagePlans,
      chunks,
      locators,
      failure
    };
  } catch (error) {
    const classified = classifyPdfExtractionError(error);
    const document: PdfDocumentPlan = {
      documentId,
      documentKey,
      regionId: initialIdentity.regionId,
      documentType: initialIdentity.documentType,
      title: initialIdentity.title,
      organization: initialIdentity.organization,
      publishedDate: initialIdentity.publishedDate,
      sourceKey: source.sourceKey,
      extractionStatus: classified.status,
      contentClassification: "empty",
      extractionMethod: "none",
      pageCount: 0,
      contentSha256: sha256(`failed:${entry.sha256}:${classified.status}`),
      dataStatus: "catalog_only",
      metadata: {
        sourcePath: entry.path,
        sourceSha256: entry.sha256,
        extractionError: classified.error
      }
    };
    return {
      source,
      document,
      pagePlans: [],
      chunks: [],
      locators,
      failure: {
        sourcePath: entry.path,
        status: classified.status,
        error: classified.error
      }
    };
  }
}

export async function normalizePdfCatalog(
  catalog: CatalogEntry[],
  options: {
    limit?: number;
    onProgress?: (progress: {
      current: number;
      total: number;
      path: string;
      status: PdfExtractionStatus;
      pages: number;
      chunks: number;
    }) => void;
  } = {}
): Promise<PdfNormalizationPlan> {
  const entries = catalog
    .filter((entry) => entry.extension === ".pdf")
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, options.limit);
  const plan: PdfNormalizationPlan = {
    sources: [],
    documents: [],
    pages: [],
    chunks: [],
    locators: [],
    failures: [],
    summary: {
      files: entries.length,
      pages: 0,
      extractedPages: 0,
      unusableForRetrievalPages: 0,
      mojibakeSuspectedPages: 0,
      classifiedEmptyPages: 0,
      failedPages: 0,
      emptyPages: 0,
      nearEmptyPages: 0,
      tableLikelyPages: 0,
      speakerRichPages: 0,
      repeatedHeaderLinesRemoved: 0,
      repeatedFooterLinesRemoved: 0,
      chunks: 0,
      extractedDocuments: 0,
      partialDocuments: 0,
      unusableForRetrievalDocuments: 0,
      mojibakeSuspectedDocuments: 0,
      emptyDocuments: 0,
      failedDocuments: 0
    }
  };

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const normalized = await normalizePdf(entry);
    plan.sources.push(normalized.source);
    plan.documents.push(normalized.document);
    plan.pages.push(...normalized.pagePlans);
    plan.chunks.push(...normalized.chunks);
    plan.locators.push(...normalized.locators);
    if (normalized.failure) plan.failures.push(normalized.failure);
    plan.summary.pages += normalized.document.pageCount;
    plan.summary.extractedPages += normalized.pagePlans.filter(
      (page) => page.contentClassification === "extracted_ok"
    ).length;
    plan.summary.unusableForRetrievalPages += normalized.pagePlans.filter(
      (page) => page.contentClassification === "unusable_for_retrieval"
    ).length;
    plan.summary.mojibakeSuspectedPages += normalized.pagePlans.filter(
      (page) => page.contentClassification === "mojibake_suspected"
    ).length;
    plan.summary.classifiedEmptyPages += normalized.pagePlans.filter(
      (page) => page.contentClassification === "empty"
    ).length;
    plan.summary.failedPages += normalized.pagePlans.filter(
      (page) => page.extractionStatus === "extraction_failed"
    ).length;
    plan.summary.emptyPages += normalized.pagePlans.filter(
      (page) => page.quality.textClass === "empty"
    ).length;
    plan.summary.nearEmptyPages += normalized.pagePlans.filter(
      (page) => page.quality.textClass === "near_empty"
    ).length;
    plan.summary.tableLikelyPages += normalized.pagePlans.filter(
      (page) =>
        page.quality.likelyTableLineCount >= 3 &&
        page.quality.likelyTableDensity >= 0.1
    ).length;
    plan.summary.speakerRichPages += normalized.pagePlans.filter(
      (page) => page.quality.speakerMarkerCount >= 5
    ).length;
    plan.summary.repeatedHeaderLinesRemoved += normalized.pagePlans.reduce(
      (total, page) => total + page.quality.repeatedHeaderLineCount,
      0
    );
    plan.summary.repeatedFooterLinesRemoved += normalized.pagePlans.reduce(
      (total, page) => total + page.quality.repeatedFooterLineCount,
      0
    );
    plan.summary.chunks += normalized.chunks.length;
    if (normalized.document.contentClassification === "mojibake_suspected") {
      plan.summary.mojibakeSuspectedDocuments += 1;
    } else if (
      normalized.document.contentClassification === "unusable_for_retrieval"
    ) {
      plan.summary.unusableForRetrievalDocuments += 1;
    } else if (normalized.document.contentClassification === "empty") {
      plan.summary.emptyDocuments += 1;
    } else if (normalized.document.extractionStatus === "extracted") {
      plan.summary.extractedDocuments += 1;
    } else if (normalized.document.extractionStatus === "partial") {
      plan.summary.partialDocuments += 1;
    } else {
      plan.summary.failedDocuments += 1;
    }
    options.onProgress?.({
      current: index + 1,
      total: entries.length,
      path: entry.path,
      status: normalized.document.extractionStatus,
      pages: normalized.document.pageCount,
      chunks: normalized.chunks.length
    });
  }
  return plan;
}
