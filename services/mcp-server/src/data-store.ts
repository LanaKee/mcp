import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import {
  dataStatusSchema,
  sourceRefSchema,
  type CouncilRecord,
  type LocalTaxRecord,
  type PolicyRecord,
  type PopulationRecord,
  type SourceRef
} from "@gb/domain";

export interface DemoDataStore {
  population: PopulationRecord[];
  taxes: LocalTaxRecord[];
  policies: PolicyRecord[];
  council: CouncilRecord[];
  sources: SourceRef[];
}

const serviceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sampleDirectory = resolve(serviceDirectory, "../../data/sample");

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(sampleDirectory, name), "utf8")) as T;
}

export async function loadDemoData(): Promise<DemoDataStore> {
  const populationRows = parse(
    await readFile(resolve(sampleDirectory, "population.csv"), "utf8"),
    { columns: true, skip_empty_lines: true, trim: true }
  ) as Record<string, string>[];
  const taxRows = parse(
    await readFile(resolve(sampleDirectory, "local-tax.csv"), "utf8"),
    { columns: true, skip_empty_lines: true, trim: true }
  ) as Record<string, string>[];

  const population: PopulationRecord[] = populationRows.map((row) => ({
    regionId: row.region_id!,
    regionName: row.region_name!,
    year: Number(row.year),
    populationTotal: Number(row.population_total),
    sourceId: row.source_id!,
    dataStatus: dataStatusSchema.parse(row.data_status)
  }));
  const taxes: LocalTaxRecord[] = taxRows.map((row) => ({
    regionId: row.region_id!,
    regionName: row.region_name!,
    fiscalYear: Number(row.fiscal_year),
    taxCategory: row.tax_category!,
    revenueAmountWon: Number(row.revenue_amount_won),
    accountingBasis: row.accounting_basis === "budget" ? "budget" : "settlement",
    sourceId: row.source_id!,
    dataStatus: dataStatusSchema.parse(row.data_status)
  }));
  const policies = await readJson<PolicyRecord[]>("policies.json");
  const council = await readJson<CouncilRecord[]>("council-records.json");
  const sources = (await readJson<unknown[]>("sources.json")).map((source) =>
    sourceRefSchema.parse(source)
  );
  return { population, taxes, policies, council, sources };
}
