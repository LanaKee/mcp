import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, type CatalogEntry } from "./catalog.js";
import {
  normalizeAnnualPopulation,
  normalizeCouncilRows,
  parseKoreanCsv,
  type NormalizedCouncilRow,
  type NormalizedPopulationRow
} from "./csv.js";
import {
  parsePopulationWorkbook,
  type WorkbookPopulationRow
} from "./xlsx.js";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const generatedDirectory = resolve(repositoryRoot, "data/generated");
const datasetDirectory = resolve(repositoryRoot, "datasets");

export interface EtlError {
  path: string;
  error: string;
}

export type OfficialPopulationRow = (
  | NormalizedPopulationRow
  | WorkbookPopulationRow
) & {
  sourcePath: string;
  sourceSha256: string;
  dataStatus: "official_observed";
};

export type OfficialCouncilRow = NormalizedCouncilRow & {
  sourcePath: string;
  sourceSha256: string;
  dataStatus: "official_observed";
};

export interface EtlResult {
  catalog: CatalogEntry[];
  population: OfficialPopulationRow[];
  council: OfficialCouncilRow[];
  errors: EtlError[];
}

export interface EtlSummary {
  mode: "write" | "dry-run";
  files: number;
  byExtension: Record<string, number>;
  byContentKind: Record<string, number>;
  normalizedPopulationRows: number;
  normalizedCouncilRows: number;
  errors: EtlError[];
  writes?: Record<string, "updated" | "unchanged">;
}

async function writeIfChanged(
  path: string,
  value: unknown
): Promise<"updated" | "unchanged"> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    if ((await readFile(path, "utf8")) === content) return "unchanged";
  } catch {
    // The first run has no previous generated file.
  }
  await mkdir(dirname(path), { recursive: true });
  const nextPath = `${path}.next`;
  await writeFile(nextPath, content, "utf8");
  await rename(nextPath, path);
  return "updated";
}

export async function collectEtlData(): Promise<EtlResult> {
  const catalog = await buildCatalog(datasetDirectory, repositoryRoot);
  const population: OfficialPopulationRow[] = [];
  const council: OfficialCouncilRow[] = [];
  const errors: EtlError[] = catalog
    .filter((entry) => entry.error)
    .map((entry) => ({ path: entry.path, error: entry.error! }));

  for (const entry of catalog) {
    try {
      const absolute = resolve(repositoryRoot, entry.path);
      if (entry.extension === ".csv" && entry.parseStatus === "parsed") {
        const parsed = parseKoreanCsv(await readFile(absolute));
        const populationRows = normalizeAnnualPopulation(parsed, entry.fileNameNfc);
        const councilRows = normalizeCouncilRows(parsed, entry.fileNameNfc);
        population.push(
          ...populationRows.map((row) => ({
            ...row,
            sourcePath: entry.path,
            sourceSha256: entry.sha256,
            dataStatus: "official_observed" as const
          }))
        );
        council.push(
          ...councilRows.map((row) => ({
            ...row,
            sourcePath: entry.path,
            sourceSha256: entry.sha256,
            dataStatus: "official_observed" as const
          }))
        );
        if (
          (parsed.kind === "population_annual" || parsed.kind === "council_agenda") &&
          parsed.rows.length > 0 &&
          populationRows.length + councilRows.length === 0
        ) {
          errors.push({
            path: entry.path,
            error: "Factual rows were skipped because no canonical Gyeongbuk region was resolved"
          });
        }
      } else if (entry.extension === ".xlsx") {
        population.push(
          ...parsePopulationWorkbook(await readFile(absolute)).map((row) => ({
            ...row,
            sourcePath: entry.path,
            sourceSha256: entry.sha256,
            dataStatus: "official_observed" as const
          }))
        );
      }
    } catch (caught) {
      errors.push({
        path: entry.path,
        error: caught instanceof Error ? caught.message : String(caught)
      });
    }
  }

  return { catalog, population, council, errors };
}

export async function runEtl(write: boolean): Promise<{
  result: EtlResult;
  summary: EtlSummary;
}> {
  const result = await collectEtlData();
  const summary: EtlSummary = {
    mode: write ? "write" : "dry-run",
    files: result.catalog.length,
    byExtension: Object.fromEntries(
      [...new Set(result.catalog.map((entry) => entry.extension))].map((extension) => [
        extension,
        result.catalog.filter((entry) => entry.extension === extension).length
      ])
    ),
    byContentKind: Object.fromEntries(
      [...new Set(result.catalog.map((entry) => entry.contentKind))].map((kind) => [
        kind,
        result.catalog.filter((entry) => entry.contentKind === kind).length
      ])
    ),
    normalizedPopulationRows: result.population.length,
    normalizedCouncilRows: result.council.length,
    errors: result.errors
  };

  if (write) {
    summary.writes = {
      catalog: await writeIfChanged(
        resolve(generatedDirectory, "catalog.json"),
        result.catalog
      ),
      population: await writeIfChanged(
        resolve(generatedDirectory, "population.normalized.json"),
        result.population
      ),
      council: await writeIfChanged(
        resolve(generatedDirectory, "council.normalized.json"),
        result.council
      ),
      errors: await writeIfChanged(
        resolve(generatedDirectory, "errors.json"),
        result.errors
      )
    };
  }
  return { result, summary };
}
