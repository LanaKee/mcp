import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import { detectCsvKind, parseKoreanCsv, type CsvKind } from "./csv.js";
import { localTaxYearbookFiscalYear } from "./local-tax-yearbook.js";
import { populationWorkbookReferenceDate } from "./xlsx.js";

export type DatasetContentKind =
  | CsvKind
  | "population_workbook"
  | "local_tax_yearbook"
  | "pdf_document"
  | "other";

export interface CatalogEntry {
  path: string;
  fileNameNfc: string;
  extension: string;
  byteSize: number;
  sha256: string;
  collectedAt: string;
  referenceDate: string | null;
  mediaType: string;
  contentKind: DatasetContentKind;
  encoding: string | null;
  dataStatus: "official_observed" | "catalog_only";
  parseStatus: "parsed" | "catalogued" | "error";
  error: string | null;
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`;
      return entry.isDirectory() ? walk(path) : [path];
    })
  );
  return nested.flat().sort((a, b) => a.localeCompare(b));
}

function referenceDate(fileName: string): string | null {
  const compact = fileName.match(/(?:19|20)\d{6}/)?.[0];
  if (compact) return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const separated = fileName.match(/(20\d{2})[-_](\d{2})[-_](\d{2})/);
  if (separated) return `${separated[1]}-${separated[2]}-${separated[3]}`;
  const monthFirst = fileName.match(/(?:^|[_\s])(\d{2})_(\d{2})_((?:19|20)\d{2})(?:[_.\s]|$)/);
  return monthFirst ? `${monthFirst[3]}-${monthFirst[1]}-${monthFirst[2]}` : null;
}

export { referenceDate as fileNameReferenceDate };

/** Population workbooks observed so far top out around 4MB; this is a generous cap. */
export const POPULATION_WORKBOOK_PARSE_MAX_BYTES = 20 * 1024 * 1024;

export const MEDIA_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".hwpx": "application/hwp+zip",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".xml": "application/xml"
};

export interface DatasetFileDescription {
  extension: string;
  mediaType: string;
  contentKind: DatasetContentKind;
  encoding: string | null;
  referenceDate: string | null;
  dataStatus: CatalogEntry["dataStatus"];
  parseStatus: CatalogEntry["parseStatus"];
  error: string | null;
}

/**
 * Classifies one raw dataset file from its bytes and name. The catalog builder and
 * the intake pipeline share this so a file is routed the same way before and after
 * it enters the immutable store.
 */
export function describeDatasetFile(
  buffer: Buffer,
  fileName: string
): DatasetFileDescription {
  const nameNfc = fileName.normalize("NFC");
  const extension = extname(nameNfc).toLowerCase();
  let contentKind: DatasetContentKind =
    extension === ".pdf"
      ? "pdf_document"
      : extension === ".xlsx"
        ? "population_workbook"
        : "other";
  let encoding: string | null = null;
  let parseStatus: CatalogEntry["parseStatus"] =
    extension === ".pdf" ? "catalogued" : "parsed";
  let error: string | null = null;
  let yearbookYear: number | null = null;
  if (extension === ".csv") {
    try {
      const parsed = parseKoreanCsv(buffer);
      contentKind = detectCsvKind(parsed.headers);
      encoding = parsed.encoding;
    } catch (caught) {
      parseStatus = "error";
      error = caught instanceof Error ? caught.message : String(caught);
    }
  } else if (extension === ".hwpx") {
    yearbookYear = localTaxYearbookFiscalYear(buffer);
    if (yearbookYear !== null) {
      contentKind = "local_tax_yearbook";
    } else {
      parseStatus = "catalogued";
    }
  }
  let xlsxReferenceDate: string | null = null;
  if (extension === ".xlsx") {
    // Every population workbook observed so far is a few MB at most; SheetJS
    // fully materializes the workbook in memory to answer this, so a
    // hundred-megabyte lookup table (e.g. a national property valuation
    // export) can exhaust the heap before it is even classified. Skip the
    // full parse for oversized files and fall back to the filename date.
    if (buffer.length <= POPULATION_WORKBOOK_PARSE_MAX_BYTES) {
      try {
        xlsxReferenceDate = populationWorkbookReferenceDate(buffer);
      } catch (caught) {
        parseStatus = "error";
        error = caught instanceof Error ? caught.message : String(caught);
      }
    } else {
      parseStatus = "catalogued";
    }
  }
  return {
    extension,
    mediaType: MEDIA_TYPES[extension] ?? "application/octet-stream",
    contentKind,
    encoding,
    referenceDate:
      extension === ".xlsx"
        ? (xlsxReferenceDate ?? referenceDate(nameNfc))
        : yearbookYear
          ? `${yearbookYear}-12-31`
          : referenceDate(nameNfc),
    dataStatus: extension === ".pdf" ? "catalog_only" : "official_observed",
    parseStatus,
    error
  };
}

/**
 * Describes every dataset file, or only those the caller asks for.
 *
 * Cataloguing reads and hashes each file, so a caller that needs a handful of
 * entries should pass `includePath` rather than building the whole tree and
 * filtering afterwards; the corpus is large enough that the difference is two
 * minutes.
 */
export async function buildCatalog(
  datasetDirectory: string,
  repositoryRoot: string,
  includePath?: (relativePath: string) => boolean
): Promise<CatalogEntry[]> {
  const allPaths = await walk(datasetDirectory);
  const paths = includePath
    ? allPaths.filter((path) =>
        includePath(relative(repositoryRoot, path).normalize("NFC"))
      )
    : allPaths;
  return Promise.all(
    paths.map(async (path): Promise<CatalogEntry> => {
      const fileStat = await stat(path);
      const buffer = await readFile(path);
      const described = describeDatasetFile(buffer, path);
      return {
        path: relative(repositoryRoot, path).normalize("NFC"),
        fileNameNfc: path.split("/").at(-1)?.normalize("NFC") ?? path.normalize("NFC"),
        extension: described.extension,
        byteSize: fileStat.size,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        collectedAt: fileStat.mtime.toISOString(),
        referenceDate: described.referenceDate,
        mediaType: described.mediaType,
        contentKind: described.contentKind,
        encoding: described.encoding,
        dataStatus: described.dataStatus,
        parseStatus: described.parseStatus,
        error: described.error
      };
    })
  );
}
