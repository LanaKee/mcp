import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, type CatalogEntry } from "./catalog.js";
import {
  normalizeAnnualPopulation,
  normalizeCouncilRows,
  normalizeCouncilBillRows,
  normalizeCouncilBillSponsorRows,
  normalizeCouncilMemberRows,
  normalizePressReleaseRows,
  normalizePopulationSnapshot,
  parseKoreanCsv,
  type NormalizedCouncilRow,
  type NormalizedCouncilBillRow,
  type NormalizedCouncilBillSponsorRow,
  type NormalizedCouncilMemberRow,
  type NormalizedPressReleaseRow,
  type NormalizedPopulationRow
} from "./csv.js";
import {
  parsePopulationWorkbook,
  type WorkbookPopulationRow
} from "./xlsx.js";
import {
  emptyLocalTaxNormalization,
  normalizeLocalTaxSources,
  type LocalTaxCsvKind,
  type LocalTaxNormalizationResult,
  type LocalTaxSourceInput
} from "./local-tax.js";
import {
  mergeLocalTaxNormalizations,
  normalizeLocalTaxYearbook
} from "./local-tax-yearbook.js";
import {
  populationRowsFromTaxPerCapita,
  type NormalizedPopulationObservation
} from "./population.js";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const generatedDirectory = resolve(repositoryRoot, "data/generated");
export const datasetDirectory = resolve(repositoryRoot, "datasets");

export interface EtlPaths {
  datasetDirectory?: string;
  generatedDirectory?: string;
}

export interface EtlError {
  path: string;
  error: string;
}

export type OfficialPopulationRow = (
  | NormalizedPopulationRow
  | WorkbookPopulationRow
  | NormalizedPopulationObservation
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

export type OfficialPressReleaseRow = NormalizedPressReleaseRow & {
  sourcePath: string;
  sourceSha256: string;
  dataStatus: "official_observed";
};

export type OfficialCouncilMemberRow = NormalizedCouncilMemberRow & {
  sourcePath: string;
  sourceSha256: string;
  dataStatus: "official_observed";
};

export type OfficialCouncilBillRow = NormalizedCouncilBillRow & {
  sourcePath: string;
  sourceSha256: string;
  dataStatus: "official_observed";
};

export type OfficialCouncilBillSponsorRow = NormalizedCouncilBillSponsorRow & {
  sourcePath: string;
  sourceSha256: string;
};

export interface EtlResult {
  catalog: CatalogEntry[];
  population: OfficialPopulationRow[];
  council: OfficialCouncilRow[];
  pressRelease: OfficialPressReleaseRow[];
  councilMember: OfficialCouncilMemberRow[];
  councilBill: OfficialCouncilBillRow[];
  councilBillSponsor: OfficialCouncilBillSponsorRow[];
  localTax: LocalTaxNormalizationResult;
  errors: EtlError[];
}

export interface EtlSummary {
  mode: "write" | "dry-run";
  files: number;
  byExtension: Record<string, number>;
  byContentKind: Record<string, number>;
  normalizedPopulationRows: number;
  normalizedCouncilRows: number;
  normalizedPressReleaseRows: number;
  normalizedCouncilMemberRows: number;
  normalizedCouncilBillRows: number;
  normalizedCouncilBillSponsorRows: number;
  normalizedLocalTaxRows: Record<string, number>;
  localTaxQualityIssues: Record<string, number>;
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

export async function collectEtlData(options: EtlPaths = {}): Promise<EtlResult> {
  const inputDirectory = options.datasetDirectory ?? datasetDirectory;
  const catalog = await buildCatalog(inputDirectory, repositoryRoot);
  const population: OfficialPopulationRow[] = [];
  const council: OfficialCouncilRow[] = [];
  const pressRelease: OfficialPressReleaseRow[] = [];
  const councilMember: OfficialCouncilMemberRow[] = [];
  const councilBill: OfficialCouncilBillRow[] = [];
  const councilBillSponsor: OfficialCouncilBillSponsorRow[] = [];
  const localTaxInputs: LocalTaxSourceInput[] = [];
  const localTaxYearbooks: LocalTaxNormalizationResult[] = [];
  const errors: EtlError[] = catalog
    .filter((entry) => entry.error)
    .map((entry) => ({ path: entry.path, error: entry.error! }));

  for (const entry of catalog) {
    try {
      const absolute = resolve(repositoryRoot, entry.path);
      if (entry.extension === ".csv" && entry.parseStatus === "parsed") {
        const parsed = parseKoreanCsv(await readFile(absolute));
        if (parsed.kind !== "other" && parsed.kind.startsWith("local_tax_")) {
          localTaxInputs.push({
            path: entry.path,
            sha256: entry.sha256,
            headers: parsed.headers,
            rows: parsed.rows,
            kind: parsed.kind as LocalTaxCsvKind
          });
        } else if (parsed.kind === "property_valuation_microdata") {
          localTaxInputs.push({
            path: entry.path,
            sha256: entry.sha256,
            headers: parsed.headers,
            rows: parsed.rows,
            kind: parsed.kind
          });
        }
        const populationRows = normalizeAnnualPopulation(parsed, entry.fileNameNfc);
        const populationSnapshotRows = normalizePopulationSnapshot(
          parsed,
          entry.fileNameNfc,
          entry.referenceDate
        );
        const councilRows = normalizeCouncilRows(parsed, entry.fileNameNfc);
        pressRelease.push(
          ...normalizePressReleaseRows(parsed, entry.fileNameNfc).map((row) => ({
            ...row,
            sourcePath: entry.path,
            sourceSha256: entry.sha256,
            dataStatus: "official_observed" as const
          }))
        );
        councilMember.push(
          ...normalizeCouncilMemberRows(parsed).map((row) => ({
            ...row,
            sourcePath: entry.path,
            sourceSha256: entry.sha256,
            dataStatus: "official_observed" as const
          }))
        );
        councilBill.push(
          ...normalizeCouncilBillRows(parsed).map((row) => ({
            ...row,
            sourcePath: entry.path,
            sourceSha256: entry.sha256,
            dataStatus: "official_observed" as const
          }))
        );
        councilBillSponsor.push(
          ...normalizeCouncilBillSponsorRows(parsed).map((row) => ({
            ...row,
            sourcePath: entry.path,
            sourceSha256: entry.sha256
          }))
        );
        population.push(
          ...[...populationRows, ...populationSnapshotRows].map((row) => ({
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
          (parsed.kind === "population_annual" ||
            parsed.kind === "population_local" ||
            parsed.kind === "council_agenda") &&
          parsed.rows.length > 0 &&
          populationRows.length +
              populationSnapshotRows.length +
              councilRows.length ===
            0
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
      } else if (
        entry.extension === ".hwpx" &&
        entry.contentKind === "local_tax_yearbook" &&
        entry.parseStatus === "parsed"
      ) {
        localTaxYearbooks.push(
          normalizeLocalTaxYearbook({
            path: entry.path,
            sha256: entry.sha256,
            buffer: await readFile(absolute)
          })
        );
      }
    } catch (caught) {
      errors.push({
        path: entry.path,
        error: caught instanceof Error ? caught.message : String(caught)
      });
    }
  }

  const localTax = mergeLocalTaxNormalizations([
    localTaxInputs.length > 0
      ? normalizeLocalTaxSources(localTaxInputs)
      : emptyLocalTaxNormalization(),
    ...localTaxYearbooks
  ]);
  population.push(
    ...populationRowsFromTaxPerCapita(localTax.perCapita).map((row) => ({
      ...row,
      dataStatus: "official_observed" as const
    }))
  );
  errors.push(
    ...localTax.qualityIssues
      .filter((issue) => issue.severity === "error")
      .map((issue) => ({
        path: issue.sourcePath,
        error: `${issue.issueCode}${
          issue.sourceRow ? ` at row ${issue.sourceRow}` : ""
        }: ${issue.message}`
      }))
  );

  return {
    catalog,
    population,
    council,
    pressRelease,
    councilMember,
    councilBill,
    councilBillSponsor,
    localTax,
    errors
  };
}

export async function runEtl(write: boolean, options: EtlPaths = {}): Promise<{
  result: EtlResult;
  summary: EtlSummary;
}> {
  const result = await collectEtlData(options);
  const outputDirectory = options.generatedDirectory ?? generatedDirectory;
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
    normalizedPressReleaseRows: result.pressRelease.length,
    normalizedCouncilMemberRows: result.councilMember.length,
    normalizedCouncilBillRows: result.councilBill.length,
    normalizedCouncilBillSponsorRows: result.councilBillSponsor.length,
    normalizedLocalTaxRows: {
      collection: result.localTax.collection.length,
      paymentMedia: result.localTax.paymentMedia.length,
      assessment: result.localTax.assessment.length,
      perCapita: result.localTax.perCapita.length,
      taxpayer: result.localTax.taxpayer.length,
      exemption: result.localTax.exemption.length,
      unrefunded: result.localTax.unrefunded.length,
      enforcement: result.localTax.enforcement.length,
      headlineRevenue: result.localTax.headlineRevenue.length
    },
    localTaxQualityIssues: Object.fromEntries(
      ["info", "warning", "error"].map((severity) => [
        severity,
        result.localTax.qualityIssues.filter(
          (issue) => issue.severity === severity
        ).length
      ])
    ),
    errors: result.errors
  };

  if (write) {
    summary.writes = {
      catalog: await writeIfChanged(
        resolve(outputDirectory, "catalog.json"),
        result.catalog
      ),
      population: await writeIfChanged(
        resolve(outputDirectory, "population.normalized.json"),
        result.population
      ),
      council: await writeIfChanged(
        resolve(outputDirectory, "council.normalized.json"),
        result.council
      ),
      pressRelease: await writeIfChanged(
        resolve(outputDirectory, "press-release.normalized.json"),
        result.pressRelease
      ),
      councilMember: await writeIfChanged(
        resolve(outputDirectory, "council-member.normalized.json"),
        result.councilMember
      ),
      councilBill: await writeIfChanged(
        resolve(outputDirectory, "council-bill.normalized.json"),
        result.councilBill
      ),
      councilBillSponsor: await writeIfChanged(
        resolve(outputDirectory, "council-bill-sponsor.normalized.json"),
        result.councilBillSponsor
      ),
      localTax: await writeIfChanged(
        resolve(outputDirectory, "local-tax.normalized.json"),
        result.localTax
      ),
      localTaxQuality: await writeIfChanged(
        resolve(outputDirectory, "local-tax.quality.report.json"),
        {
          reportVersion: "local-tax-quality-v1",
          counts: summary.normalizedLocalTaxRows,
          qualityIssues: result.localTax.qualityIssues,
          reconciliations: result.localTax.reconciliations,
          excludedPropertyRows: result.localTax.excludedPropertyRows,
          quarantinedRows: result.localTax.quarantinedRows
        }
      ),
      errors: await writeIfChanged(
        resolve(outputDirectory, "errors.json"),
        result.errors
      )
    };
  }
  return { result, summary };
}
