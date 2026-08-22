import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadDatabase, type DatabaseLoadResult } from "./db.js";
import { createEmbeddingProvider } from "./embeddings.js";
import { generatedDirectory, runEtl, type EtlResult } from "./etl.js";
import { createLoadPlan } from "./load-plan.js";
import { loadPdfDatabase } from "./pdf-db.js";
import { normalizePdfCatalog } from "./pdf.js";

export interface NormalizeAndLoadOptions {
  databaseUrl: string;
  /** `regenerate` re-runs the ETL over `datasets/`; `generated` reuses artifacts. */
  source?: "regenerate" | "generated";
  applySchema?: boolean;
  skipPdf?: boolean;
  pdfLimit?: number;
  embeddingProvider?: string;
  allowExternal?: boolean;
  embeddingBatchSize?: number;
  onExtractionProgress?: (progress: {
    current: number;
    total: number;
    status: string;
    pages: number;
    chunks: number;
  }) => void;
}

export interface NormalizeAndLoadResult {
  normalized: {
    files: number;
    population: number;
    council: number;
    pressReleases: number;
    localTax: number;
    localTaxQualityIssues: number;
    errors: number;
  };
  load: DatabaseLoadResult;
  pdf: {
    extraction: Awaited<ReturnType<typeof normalizePdfCatalog>>["summary"];
    failures: number;
    load: Awaited<ReturnType<typeof loadPdfDatabase>>;
  } | null;
}

export async function readGeneratedEtl(): Promise<EtlResult> {
  const [catalog, population, council, localTax, errors] = await Promise.all(
    [
      "catalog.json",
      "population.normalized.json",
      "council.normalized.json",
      "local-tax.normalized.json",
      "errors.json"
    ].map(
      async (file) =>
        JSON.parse(await readFile(resolve(generatedDirectory, file), "utf8")) as unknown
    )
  );
  // Generated trees produced before press releases existed simply have no file;
  // treating that as an empty dataset keeps `load-only` runs working.
  const pressRelease = await readFile(
    resolve(generatedDirectory, "press-release.normalized.json"),
    "utf8"
  )
    .then((raw) => JSON.parse(raw) as EtlResult["pressRelease"])
    .catch(() => [] as EtlResult["pressRelease"]);
  return {
    catalog: catalog as EtlResult["catalog"],
    population: population as EtlResult["population"],
    council: council as EtlResult["council"],
    pressRelease,
    localTax: localTax as EtlResult["localTax"],
    errors: errors as EtlResult["errors"]
  };
}

/**
 * Normalizes the current contents of the raw store and loads the result into
 * PostgreSQL. Loading is upsert-based, so re-processing an unchanged store is a
 * no-op rather than a source of duplicate facts.
 */
export async function normalizeAndLoad(
  options: NormalizeAndLoadOptions
): Promise<NormalizeAndLoadResult> {
  const regenerate = (options.source ?? "regenerate") === "regenerate";
  const etl = regenerate ? (await runEtl(true)).result : await readGeneratedEtl();
  const severeTaxIssues = etl.localTax.qualityIssues.filter(
    (issue) => issue.severity === "error"
  );
  if (severeTaxIssues.length > 0) {
    throw new Error(
      `Local-tax normalization has ${severeTaxIssues.length} severe quality issue(s); database load was refused. Review data/generated/local-tax.quality.report.json.`
    );
  }
  const plan = await createLoadPlan(etl);
  const load = await loadDatabase(options.databaseUrl, plan, {
    applySchema: options.applySchema ?? true
  });

  let pdf: NormalizeAndLoadResult["pdf"] = null;
  if (regenerate && !options.skipPdf) {
    const provider = createEmbeddingProvider({
      provider: options.embeddingProvider ?? "hashed",
      allowExternal: options.allowExternal
    });
    const normalizedPdf = await normalizePdfCatalog(etl.catalog, {
      limit: options.pdfLimit,
      onProgress: options.onExtractionProgress
    });
    pdf = {
      extraction: normalizedPdf.summary,
      failures: normalizedPdf.failures.length,
      load: await loadPdfDatabase(options.databaseUrl, normalizedPdf, provider, {
        applySchema: false,
        embeddingBatchSize: options.embeddingBatchSize
      })
    };
  }

  return {
    normalized: {
      files: etl.catalog.length,
      population: etl.population.length,
      council: etl.council.length,
      pressReleases: etl.pressRelease.length,
      localTax: etl.localTax.headlineRevenue.length,
      localTaxQualityIssues: etl.localTax.qualityIssues.length,
      errors: etl.errors.length
    },
    load,
    pdf
  };
}
