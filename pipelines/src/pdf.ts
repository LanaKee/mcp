import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { CatalogEntry } from "./catalog.js";
import { repositoryRoot } from "./etl.js";
import { officialSourceKey, type PlannedLocator, type PlannedSource } from "./load-plan.js";
import { resolveGyeongbukRegion } from "./regions.js";

export type PdfExtractionStatus =
  | "extracted"
  | "partial"
  | "ocr_required"
  | "extraction_failed"
  | "password_required";

export interface ExtractedPdfPage {
  pageNumber: number;
  text: string;
  contentSha256: string;
  status: "extracted" | "ocr_required" | "extraction_failed";
  error: string | null;
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
  chunks: PdfChunkPlan[];
  locators: PlannedLocator[];
  failures: PdfNormalizationFailure[];
  summary: {
    files: number;
    pages: number;
    extractedPages: number;
    ocrRequiredPages: number;
    failedPages: number;
    chunks: number;
    extractedDocuments: number;
    partialDocuments: number;
    ocrRequiredDocuments: number;
    failedDocuments: number;
  };
}

export interface PdfChunkingOptions {
  maxChars?: number;
  overlapChars?: number;
}

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
    .map((line) => line.replace(/[ \t]+/gu, " ").trim())
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
  const ocrRequired = pages.filter((page) => page.status === "ocr_required").length;
  if (extracted === 0) return failed > 0 ? "extraction_failed" : "ocr_required";
  return failed > 0 || ocrRequired > 0 ? "partial" : "extracted";
}

function appendItem(line: string, item: string): string {
  if (!line) return item;
  if (/^[,.;:!?%)\]}]/u.test(item) || /[(\[{]$/u.test(line)) return `${line}${item}`;
  return `${line} ${item}`;
}

function pageTextFromItems(items: unknown[]): string {
  const lines: string[] = [];
  let line = "";
  let previousY: number | null = null;
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
    };
    const text = item.str.replace(/\s+/gu, " ").trim();
    const y = item.transform?.[5];
    const threshold = Math.max(2, (item.height ?? 8) * 0.45);
    if (
      line &&
      typeof y === "number" &&
      previousY !== null &&
      Math.abs(y - previousY) > threshold
    ) {
      lines.push(line);
      line = "";
    }
    if (text) line = appendItem(line, text);
    if (item.hasEOL && line) {
      lines.push(line);
      line = "";
    }
    if (typeof y === "number") previousY = y;
  }
  if (line) lines.push(line);
  return normalizeExtractedText(lines.join("\n"));
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
        const text = pageTextFromItems(content.items);
        pages.push({
          pageNumber,
          text,
          contentSha256: sha256(text),
          status: text ? "extracted" : "ocr_required",
          error: null
        });
        page.cleanup();
      } catch (error) {
        pages.push({
          pageNumber,
          text: "",
          contentSha256: sha256(""),
          status: "extraction_failed",
          error: safeError(error)
        });
      }
    }
    return { pageCount: pdf.numPages, pages };
  } finally {
    await loadingTask.destroy();
  }
}

function isHeading(line: string): boolean {
  return (
    line.length <= 80 &&
    (/^[제\d]+[호장절항]/u.test(line) ||
      /^\[[^\]]+\]$/u.test(line) ||
      /(?:위원회|회의록|감사|보고|질의|답변)$/u.test(line))
  );
}

function semanticParagraphs(text: string): string[] {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) paragraphs.push(current.join(" ").trim());
    current = [];
  };
  for (const line of lines) {
    if (isHeading(line)) {
      flush();
      paragraphs.push(line);
      continue;
    }
    current.push(line);
    if (
      /(?:[.!?。！？]|다\.?|임\.?|함\.?|음\.?)$/u.test(line) ||
      current.join(" ").length >= 500
    ) {
      flush();
    }
  }
  flush();
  return paragraphs;
}

function splitLongParagraph(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  const sentences = paragraph
    .split(/(?<=[.!?。！？])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const results: string[] = [];
  let current = "";
  for (const sentence of sentences.length > 1 ? sentences : [paragraph]) {
    if (sentence.length > maxChars) {
      if (current) results.push(current);
      current = "";
      for (let index = 0; index < sentence.length; index += maxChars) {
        results.push(sentence.slice(index, index + maxChars).trim());
      }
    } else if (!current) {
      current = sentence;
    } else if (current.length + sentence.length + 1 <= maxChars) {
      current = `${current} ${sentence}`;
    } else {
      results.push(current);
      current = sentence;
    }
  }
  if (current) results.push(current);
  return results.filter(Boolean);
}

function overlapSegments(segments: string[], overlapChars: number): string[] {
  const overlap: string[] = [];
  let length = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    if (overlap.length > 0 && length + segment.length > overlapChars) break;
    overlap.unshift(segment);
    length += segment.length;
  }
  return overlap;
}

export function chunkPdfPages(
  documentKey: string,
  documentId: string,
  pages: ExtractedPdfPage[],
  options: PdfChunkingOptions = {}
): PdfChunkPlan[] {
  const maxChars = options.maxChars ?? 1200;
  const overlapChars = Math.min(options.overlapChars ?? 160, Math.floor(maxChars / 3));
  const chunks: PdfChunkPlan[] = [];
  let chunkIndex = 0;

  for (const page of pages) {
    if (!page.text) continue;
    const segments = semanticParagraphs(page.text).flatMap((paragraph) =>
      splitLongParagraph(paragraph, maxChars)
    );
    let current: string[] = [];
    let pageChunkIndex = 0;
    const flush = () => {
      const content = current.join("\n\n").trim();
      if (!content) return;
      const chunkKey = `${documentKey}:page:${page.pageNumber}:chunk:${pageChunkIndex}`;
      const contentSha256 = sha256(content);
      chunks.push({
        chunkId: deterministicUuid(chunkKey),
        chunkKey,
        documentId,
        chunkIndex,
        pageStart: page.pageNumber,
        pageEnd: page.pageNumber,
        sectionTitle:
          current[0] && isHeading(current[0]) ? current[0].slice(0, 200) : null,
        content,
        contentSha256,
        tokenCount: content.split(/\s+/u).filter(Boolean).length,
        metadata: {
          pageChunkIndex,
          overlapChars,
          extractionPageSha256: page.contentSha256
        }
      });
      chunkIndex += 1;
      pageChunkIndex += 1;
    };

    for (const segment of segments) {
      const nextLength = [...current, segment].join("\n\n").length;
      if (current.length > 0 && nextLength > maxChars) {
        const previous = current;
        flush();
        current = overlapSegments(previous, overlapChars);
        while (
          current.length > 0 &&
          [...current, segment].join("\n\n").length > maxChars
        ) {
          current.shift();
        }
      }
      current.push(segment);
    }
    flush();
  }
  return chunks;
}

function documentType(path: string): string {
  const normalized = path.normalize("NFC");
  if (normalized.includes("행정사무감사")) return "council_audit_minutes";
  return "council_minutes";
}

function sourceFromCatalog(entry: CatalogEntry): PlannedSource {
  return {
    sourceKey: officialSourceKey(entry.path, entry.sha256),
    title: entry.fileNameNfc,
    provider: resolveGyeongbukRegion(entry.path)?.regionName ?? "공공데이터 원천",
    sourceUrl: null,
    licenseNote: null,
    filePath: entry.path,
    fileSha256: entry.sha256,
    collectedAt: entry.collectedAt,
    referenceDate: entry.referenceDate,
    mediaType: entry.mediaType,
    dataStatus: "catalog_only",
    isOfficial: true,
    metadata: {
      byteSize: entry.byteSize,
      contentKind: entry.contentKind,
      parseStatus: entry.parseStatus
    }
  };
}

async function normalizePdf(entry: CatalogEntry): Promise<{
  source: PlannedSource;
  document: PdfDocumentPlan;
  chunks: PdfChunkPlan[];
  locators: PlannedLocator[];
  failure: PdfNormalizationFailure | null;
  pages: ExtractedPdfPage[];
}> {
  const source = sourceFromCatalog(entry);
  const documentKey = `document-${sha256(source.sourceKey).slice(0, 48)}`;
  const documentId = deterministicUuid(documentKey);
  const region = resolveGyeongbukRegion(entry.path);
  const base = {
    documentId,
    documentKey,
    regionId: region?.regionId ?? null,
    documentType: documentType(entry.path),
    title: entry.fileNameNfc.slice(0, -extname(entry.fileNameNfc).length),
    organization: region
      ? region.regionType === "province"
        ? "경상북도의회"
        : `${region.regionName}의회`
      : null,
    publishedDate: entry.referenceDate,
    sourceKey: source.sourceKey
  };
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
    const extractedPages = extracted.pages.filter((page) => page.status === "extracted");
    const failedPages = extracted.pages.filter(
      (page) => page.status === "extraction_failed"
    );
    const ocrPages = extracted.pages.filter((page) => page.status === "ocr_required");
    const extractionStatus = extractionStatusForPages(extracted.pages);
    const chunks = chunkPdfPages(documentKey, documentId, extracted.pages);
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
    for (const page of [...failedPages, ...ocrPages]) {
      locators.push({
        sourceKey: source.sourceKey,
        entityType: "pdf_page_status",
        entityKey: `${documentKey}:page:${page.pageNumber}`,
        pageNumber: page.pageNumber,
        rowNumber: null,
        sectionName: page.status,
        characterStart: null,
        characterEnd: null,
        locatorText: `${entry.path}#page=${page.pageNumber};status=${page.status}`
      });
    }
    const document: PdfDocumentPlan = {
      ...base,
      extractionStatus,
      pageCount: extracted.pageCount,
      contentSha256: sha256(
        extracted.pages
          .map((page) => `${page.pageNumber}:${page.contentSha256}`)
          .join("\n")
      ),
      dataStatus: extractedPages.length > 0 ? "official_observed" : "catalog_only",
      metadata: {
        sourcePath: entry.path,
        sourceSha256: entry.sha256,
        extractedPages: extractedPages.length,
        ocrRequiredPages: ocrPages.map((page) => page.pageNumber),
        failedPages: failedPages.map((page) => ({
          pageNumber: page.pageNumber,
          error: page.error
        }))
      }
    };
    const failure =
      extractionStatus === "extracted"
        ? null
        : {
            sourcePath: entry.path,
            status: extractionStatus,
            error:
              extractionStatus === "partial"
                ? `${failedPages.length} failed pages; ${ocrPages.length} OCR-required pages`
                : extractionStatus === "ocr_required"
                  ? "No extractable text; OCR is required"
                  : "No usable text was extracted because page extraction failed"
          };
    return { source, document, chunks, locators, failure, pages: extracted.pages };
  } catch (error) {
    const classified = classifyPdfExtractionError(error);
    const document: PdfDocumentPlan = {
      ...base,
      extractionStatus: classified.status,
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
      chunks: [],
      locators,
      failure: {
        sourcePath: entry.path,
        status: classified.status,
        error: classified.error
      },
      pages: []
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
    chunks: [],
    locators: [],
    failures: [],
    summary: {
      files: entries.length,
      pages: 0,
      extractedPages: 0,
      ocrRequiredPages: 0,
      failedPages: 0,
      chunks: 0,
      extractedDocuments: 0,
      partialDocuments: 0,
      ocrRequiredDocuments: 0,
      failedDocuments: 0
    }
  };

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const normalized = await normalizePdf(entry);
    plan.sources.push(normalized.source);
    plan.documents.push(normalized.document);
    plan.chunks.push(...normalized.chunks);
    plan.locators.push(...normalized.locators);
    if (normalized.failure) plan.failures.push(normalized.failure);
    plan.summary.pages += normalized.document.pageCount;
    plan.summary.extractedPages += normalized.pages.filter(
      (page) => page.status === "extracted"
    ).length;
    plan.summary.ocrRequiredPages += normalized.pages.filter(
      (page) => page.status === "ocr_required"
    ).length;
    plan.summary.failedPages += normalized.pages.filter(
      (page) => page.status === "extraction_failed"
    ).length;
    plan.summary.chunks += normalized.chunks.length;
    if (normalized.document.extractionStatus === "extracted") {
      plan.summary.extractedDocuments += 1;
    } else if (normalized.document.extractionStatus === "partial") {
      plan.summary.partialDocuments += 1;
    } else if (normalized.document.extractionStatus === "ocr_required") {
      plan.summary.ocrRequiredDocuments += 1;
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
