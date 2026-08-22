import type { NormalizedTaxPerCapita } from "./local-tax.js";

export type PopulationMeasurementBasis =
  | "resident_registration_snapshot"
  | "tax_year_reported_population"
  | "annual_statistical_population"
  | "demo_annual_population";

export type ReferenceDatePrecision = "day" | "month" | "year";

export interface NormalizedPopulationObservation {
  regionName: string;
  referenceDate: string;
  populationTotal: number;
  populationMale: number | null;
  populationFemale: number | null;
  householdCount: number | null;
  foreignPopulation: number | null;
  measurementBasis: PopulationMeasurementBasis;
  referenceDatePrecision: ReferenceDatePrecision;
  metadata: Record<string, unknown>;
  sourceRow: number;
}

export function populationRowsFromTaxPerCapita(
  rows: NormalizedTaxPerCapita[]
): Array<
  NormalizedPopulationObservation & {
    sourcePath: string;
    sourceSha256: string;
  }
> {
  return rows.flatMap((row) =>
    row.populationCount !== null && row.populationCount > 0
      ? [{
          regionName: row.regionName,
          referenceDate: `${row.fiscalYear}-12-31`,
          populationTotal: row.populationCount,
          populationMale: null,
          populationFemale: null,
          householdCount: row.householdCount,
          foreignPopulation: null,
          measurementBasis: "tax_year_reported_population" as const,
          referenceDatePrecision: "year" as const,
          metadata: {
            sourceGrain: "local_tax_per_capita_burden",
            sourcePeriodLabel: String(row.fiscalYear),
            referenceDateRole: "canonical_tax_year_period_end"
          },
          sourcePath: row.sourcePath,
          sourceSha256: row.sourceSha256,
          sourceRow: row.sourceRow
        }]
      : []
  );
}
