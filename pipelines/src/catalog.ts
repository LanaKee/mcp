import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import { detectCsvKind, parseKoreanCsv, type CsvKind } from "./csv.js";

export interface CatalogEntry {
  path: string;
  fileNameNfc: string;
  extension: string;
  byteSize: number;
  sha256: string;
  collectedAt: string;
  referenceDate: string | null;
  mediaType: string;
  contentKind: CsvKind | "population_workbook" | "pdf_document" | "other";
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
  return separated ? `${separated[1]}-${separated[2]}-${separated[3]}` : null;
}

const mediaTypes: Record<string, string> = {
  ".csv": "text/csv",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".xml": "application/xml"
};

export async function buildCatalog(
  datasetDirectory: string,
  repositoryRoot: string
): Promise<CatalogEntry[]> {
  const paths = await walk(datasetDirectory);
  return Promise.all(
    paths.map(async (path): Promise<CatalogEntry> => {
      const extension = extname(path).toLowerCase();
      const fileStat = await stat(path);
      const buffer = await readFile(path);
      let contentKind: CatalogEntry["contentKind"] =
        extension === ".pdf"
          ? "pdf_document"
          : extension === ".xlsx"
            ? "population_workbook"
            : "other";
      let encoding: string | null = null;
      let parseStatus: CatalogEntry["parseStatus"] =
        extension === ".pdf" ? "catalogued" : "parsed";
      let error: string | null = null;
      if (extension === ".csv") {
        try {
          const parsed = parseKoreanCsv(buffer);
          contentKind = detectCsvKind(parsed.headers);
          encoding = parsed.encoding;
        } catch (caught) {
          parseStatus = "error";
          error = caught instanceof Error ? caught.message : String(caught);
        }
      }
      return {
        path: relative(repositoryRoot, path).normalize("NFC"),
        fileNameNfc: path.split("/").at(-1)?.normalize("NFC") ?? path.normalize("NFC"),
        extension,
        byteSize: fileStat.size,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        collectedAt: fileStat.mtime.toISOString(),
        referenceDate: referenceDate(path.normalize("NFC")),
        mediaType: mediaTypes[extension] ?? "application/octet-stream",
        contentKind,
        encoding,
        dataStatus: extension === ".pdf" ? "catalog_only" : "official_observed",
        parseStatus,
        error
      };
    })
  );
}

