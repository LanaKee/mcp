import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client, type QueryResultRow } from "pg";
import { repositoryRoot } from "./etl.js";
import type { LoadPlan } from "./load-plan.js";

const batchSize = 500;

export interface DatabaseIssue {
  kind: string;
  code: string | null;
  message: string;
}

export class DatabaseOperationError extends Error {
  readonly issue: DatabaseIssue;

  constructor(issue: DatabaseIssue) {
    super(`${issue.kind}: ${issue.message}`);
    this.name = "DatabaseOperationError";
    this.issue = issue;
  }
}

export interface IntegrityCount {
  tableName: string;
  dataStatus: string;
  rowCount: number;
}

export interface DatabaseLoadResult {
  ingestionRunId: string;
  status: "succeeded" | "partial";
  insertedCount: number;
  updatedCount: number;
  errorCount: number;
  planCounts: {
    regions: number;
    sources: number;
    population: number;
    localTax: number;
    taxCollection: number;
    taxPaymentMedia: number;
    taxAssessment: number;
    taxPerCapita: number;
    taxTaxpayer: number;
    taxExemption: number;
    taxUnrefunded: number;
    taxEnforcement: number;
    taxQualityIssues: number;
    policies: number;
    council: number;
    locators: number;
  };
  integrity: IntegrityCount[];
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  returned: QueryResultRow[];
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/giu, "$1***@")
    .replace(/password\s*=\s*[^\s]+/giu, "password=***");
}

export function classifyDatabaseError(error: unknown): DatabaseIssue {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const kinds: Record<string, string> = {
    ECONNREFUSED: "connection_refused",
    ENOTFOUND: "dns_resolution_failed",
    ETIMEDOUT: "connection_timeout",
    "28P01": "authentication_failed",
    "3D000": "database_not_found",
    "42501": "insufficient_privilege",
    "42P01": "schema_missing",
    "42703": "schema_outdated"
  };
  return {
    kind: kinds[code] ?? (code ? `postgres_${code}` : "database_error"),
    code: code || null,
    message: safeMessage(error)
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export async function upsertRows(
  client: Client,
  options: {
    table: string;
    columns: string[];
    rows: unknown[][];
    conflictColumns: string[];
    updateColumns: string[];
    returningColumns?: string[];
  }
): Promise<UpsertResult> {
  let inserted = 0;
  let updated = 0;
  const returned: QueryResultRow[] = [];
  for (let offset = 0; offset < options.rows.length; offset += batchSize) {
    const rows = options.rows.slice(offset, offset + batchSize);
    const values = rows.flat();
    const tuples = rows.map((_, rowIndex) => {
      const start = rowIndex * options.columns.length;
      return `(${options.columns.map((__, columnIndex) => `$${start + columnIndex + 1}`).join(", ")})`;
    });
    const updateSql =
      options.updateColumns.length > 0
        ? `DO UPDATE SET ${options.updateColumns
            .map(
              (column) =>
                `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`
            )
            .join(", ")}`
        : "DO NOTHING";
    const returning = [
      ...(options.returningColumns ?? []).map(quoteIdentifier),
      "(xmax = 0) AS inserted"
    ].join(", ");
    const result = await client.query(
      `INSERT INTO ${quoteIdentifier(options.table)}
        (${options.columns.map(quoteIdentifier).join(", ")})
       VALUES ${tuples.join(", ")}
       ON CONFLICT (${options.conflictColumns.map(quoteIdentifier).join(", ")})
       ${updateSql}
       RETURNING ${returning}`,
      values
    );
    for (const row of result.rows) {
      if (row.inserted === true) inserted += 1;
      else updated += 1;
      returned.push(row);
    }
  }
  return { inserted, updated, returned };
}

export async function applyDatabaseSchema(client: Client): Promise<void> {
  const schema = await readFile(resolve(repositoryRoot, "db/schema.sql"), "utf8");
  const normalizedLoadingMigration = await readFile(
    resolve(repositoryRoot, "db/migrations/002_normalized_loading.sql"),
    "utf8"
  );
  const pdfDocumentsMigration = await readFile(
    resolve(repositoryRoot, "db/migrations/003_pdf_documents_embeddings.sql"),
    "utf8"
  );
  const repositoryAuditMigration = await readFile(
    resolve(repositoryRoot, "db/migrations/004_mcp_repository_audit.sql"),
    "utf8"
  );
  const httpHardeningMigration = await readFile(
    resolve(repositoryRoot, "db/migrations/005_http_hardening_audit.sql"),
    "utf8"
  );
  const pdfPageQualityMigration = await readFile(
    resolve(repositoryRoot, "db/migrations/006_pdf_page_quality.sql"),
    "utf8"
  );
  const sourceLifecycleMigration = await readFile(
    resolve(repositoryRoot, "db/migrations/007_source_lifecycle_retention.sql"),
    "utf8"
  );
  const officialLocalTaxMigration = await readFile(
    resolve(repositoryRoot, "db/migrations/008_official_local_tax_facts.sql"),
    "utf8"
  );
  const localTaxYearbookMigration = await readFile(
    resolve(
      repositoryRoot,
      "db/migrations/009_local_tax_yearbook_coverage.sql"
    ),
    "utf8"
  );
  const policyDocumentQualityMigration = await readFile(
    resolve(
      repositoryRoot,
      "db/migrations/010_policy_document_text_quality.sql"
    ),
    "utf8"
  );
  const existing = await client.query<{ document_table: string | null }>(
    "SELECT to_regclass('public.document')::text AS document_table"
  );
  if (existing.rows[0]?.document_table) {
    await client.query(normalizedLoadingMigration);
    await client.query(pdfDocumentsMigration);
    await client.query(repositoryAuditMigration);
    await client.query(httpHardeningMigration);
    await client.query(pdfPageQualityMigration);
    await client.query(sourceLifecycleMigration);
    await client.query(officialLocalTaxMigration);
    await client.query(localTaxYearbookMigration);
    await client.query(policyDocumentQualityMigration);
    await client.query(schema);
  } else {
    await client.query(schema);
    await client.query(normalizedLoadingMigration);
    await client.query(pdfDocumentsMigration);
    await client.query(repositoryAuditMigration);
    await client.query(httpHardeningMigration);
    await client.query(pdfPageQualityMigration);
    await client.query(sourceLifecycleMigration);
    await client.query(officialLocalTaxMigration);
    await client.query(localTaxYearbookMigration);
    await client.query(policyDocumentQualityMigration);
  }
}

function sourceId(
  sourceIds: Map<string, string>,
  sourceKey: string
): string {
  const value = sourceIds.get(sourceKey);
  if (!value) throw new Error(`Missing loaded source mapping for ${sourceKey}`);
  return value;
}

function addCounts(
  totals: { inserted: number; updated: number },
  result: UpsertResult
): void {
  totals.inserted += result.inserted;
  totals.updated += result.updated;
}

async function integrityCounts(client: Client): Promise<IntegrityCount[]> {
  const result = await client.query<{
    table_name: string;
    data_status: string;
    row_count: string;
  }>(`
    SELECT 'data_source' AS table_name, data_status, count(*)::text AS row_count
      FROM data_source GROUP BY data_status
    UNION ALL
    SELECT 'population_observation', data_status, count(*)::text
      FROM population_observation GROUP BY data_status
    UNION ALL
    SELECT 'local_tax_revenue', data_status, count(*)::text
      FROM local_tax_revenue GROUP BY data_status
    UNION ALL
    SELECT 'local_tax_collection_status', data_status, count(*)::text
      FROM local_tax_collection_status GROUP BY data_status
    UNION ALL
    SELECT 'local_tax_payment_media', data_status, count(*)::text
      FROM local_tax_payment_media GROUP BY data_status
    UNION ALL
    SELECT 'local_tax_assessment_status', data_status, count(*)::text
      FROM local_tax_assessment_status GROUP BY data_status
    UNION ALL
    SELECT 'local_tax_per_capita_burden', data_status, count(*)::text
      FROM local_tax_per_capita_burden GROUP BY data_status
    UNION ALL
    SELECT 'local_tax_taxpayer_status', data_status, count(*)::text
      FROM local_tax_taxpayer_status GROUP BY data_status
    UNION ALL
    SELECT 'local_tax_exemption_status', data_status, count(*)::text
      FROM local_tax_exemption_status GROUP BY data_status
    UNION ALL
    SELECT 'local_tax_unrefunded_status', data_status, count(*)::text
      FROM local_tax_unrefunded_status GROUP BY data_status
    UNION ALL
    SELECT 'local_tax_enforcement_statistic', data_status, count(*)::text
      FROM local_tax_enforcement_statistic GROUP BY data_status
    UNION ALL
    SELECT 'data_quality_issue', severity, count(*)::text
      FROM data_quality_issue GROUP BY severity
    UNION ALL
    SELECT 'policy_program', data_status, count(*)::text
      FROM policy_program GROUP BY data_status
    UNION ALL
    SELECT 'council_record', data_status, count(*)::text
      FROM council_record GROUP BY data_status
    UNION ALL
    SELECT 'source_locator', entity_type, count(*)::text
      FROM source_locator GROUP BY entity_type
    UNION ALL
    SELECT 'dim_region', region_type, count(*)::text
      FROM dim_region GROUP BY region_type
    ORDER BY 1, 2
  `);
  return result.rows.map((row) => ({
    tableName: row.table_name,
    dataStatus: row.data_status,
    rowCount: Number(row.row_count)
  }));
}

export async function loadDatabase(
  databaseUrl: string,
  plan: LoadPlan,
  options: { applySchema?: boolean } = {}
): Promise<DatabaseLoadResult> {
  const client = new Client({ connectionString: databaseUrl });
  let ingestionRunId: string | null = null;
  let transactionStarted = false;
  try {
    await client.connect();
    if (options.applySchema !== false) await applyDatabaseSchema(client);

    const run = await client.query<{ ingestion_run_id: string }>(
      `INSERT INTO ingestion_run
        (pipeline_name, pipeline_version, status, input_sha256, error_count, error_report)
       VALUES ($1, $2, 'running', $3, $4, $5::jsonb)
       RETURNING ingestion_run_id`,
      [
        "gyeongbuk-normalized-loader",
        "0.1.0",
        plan.inputSha256,
        plan.rejected.length,
        JSON.stringify(plan.rejected.slice(0, 200))
      ]
    );
    ingestionRunId = run.rows[0]!.ingestion_run_id;

    await client.query("BEGIN");
    transactionStarted = true;
    const totals = { inserted: 0, updated: 0 };

    addCounts(
      totals,
      await upsertRows(client, {
        table: "dim_region",
        columns: [
          "region_id",
          "region_name",
          "region_type",
          "parent_region_id",
          "normalized_name"
        ],
        rows: plan.regions.map((row) => [
          row.regionId,
          row.regionName,
          row.regionType,
          row.parentRegionId,
          row.normalizedName
        ]),
        conflictColumns: ["region_id"],
        updateColumns: [
          "region_name",
          "region_type",
          "parent_region_id",
          "normalized_name"
        ]
      })
    );

    const sourceResult = await upsertRows(client, {
      table: "data_source",
      columns: [
        "source_key",
        "title",
        "provider",
        "source_url",
        "license_note",
        "file_path",
        "file_sha256",
        "collected_at",
        "reference_date",
        "media_type",
        "data_status",
        "is_official",
        "metadata"
      ],
      rows: plan.sources.map((row) => [
        row.sourceKey,
        row.title,
        row.provider,
        row.sourceUrl,
        row.licenseNote,
        row.filePath,
        row.fileSha256,
        row.collectedAt,
        row.referenceDate,
        row.mediaType,
        row.dataStatus,
        row.isOfficial,
        JSON.stringify(row.metadata)
      ]),
      conflictColumns: ["source_key"],
      updateColumns: [
        "title",
        "provider",
        "source_url",
        "license_note",
        "file_path",
        "file_sha256",
        "collected_at",
        "reference_date",
        "media_type",
        "data_status",
        "is_official",
        "metadata"
      ],
      returningColumns: ["source_key", "source_id"]
    });
    addCounts(totals, sourceResult);
    const sourceIds = new Map(
      sourceResult.returned.map((row) => [
        String(row.source_key),
        String(row.source_id)
      ])
    );

    addCounts(
      totals,
      await upsertRows(client, {
        table: "population_observation",
        columns: [
          "region_id",
          "reference_date",
          "population_total",
          "population_male",
          "population_female",
          "household_count",
          "foreign_population",
          "source_id",
          "ingestion_run_id",
          "source_row",
          "data_status"
        ],
        rows: plan.population.map((row) => [
          row.regionId,
          row.referenceDate,
          row.populationTotal,
          row.populationMale,
          row.populationFemale,
          row.householdCount,
          row.foreignPopulation,
          sourceId(sourceIds, row.sourceKey),
          ingestionRunId,
          row.sourceRow,
          row.dataStatus
        ]),
        conflictColumns: ["region_id", "reference_date", "source_id"],
        updateColumns: [
          "population_total",
          "population_male",
          "population_female",
          "household_count",
          "foreign_population",
          "ingestion_run_id",
          "source_row",
          "data_status"
        ]
      })
    );

    addCounts(
      totals,
      await upsertRows(client, {
        table: "local_tax_collection_status",
        columns: [
          "region_id",
          "fiscal_year",
          "tax_category",
          "assessed_amount_won",
          "collected_amount_won",
          "refunded_amount_won",
          "written_off_amount_won",
          "uncollected_amount_won",
          "reported_collection_rate",
          "computed_collection_rate",
          "unit_original",
          "unit_multiplier",
          "unit_provenance",
          "is_aggregate",
          "source_id",
          "source_row",
          "ingestion_run_id",
          "data_status",
          "metadata"
        ],
        rows: plan.taxCollection.map((row) => [
          row.regionId,
          row.fiscalYear,
          row.taxCategory,
          row.assessedAmountWon,
          row.collectedAmountWon,
          row.refundedAmountWon,
          row.writtenOffAmountWon,
          row.uncollectedAmountWon,
          row.reportedCollectionRate,
          row.computedCollectionRate,
          row.unitOriginal,
          row.unitMultiplier,
          row.unitProvenance,
          row.isAggregate,
          sourceId(sourceIds, row.sourceKey),
          row.sourceRow,
          ingestionRunId,
          "official_observed",
          "{}"
        ]),
        conflictColumns: ["source_id", "source_row"],
        updateColumns: [
          "region_id",
          "fiscal_year",
          "tax_category",
          "assessed_amount_won",
          "collected_amount_won",
          "refunded_amount_won",
          "written_off_amount_won",
          "uncollected_amount_won",
          "reported_collection_rate",
          "computed_collection_rate",
          "unit_original",
          "unit_multiplier",
          "unit_provenance",
          "is_aggregate",
          "ingestion_run_id",
          "data_status"
        ]
      })
    );

    addCounts(
      totals,
      await upsertRows(client, {
        table: "local_tax_payment_media",
        columns: [
          "region_id",
          "fiscal_year",
          "tax_category",
          "payment_method",
          "electronic_notice",
          "payment_count",
          "payment_amount_won",
          "reported_media_share",
          "unit_original",
          "unit_multiplier",
          "unit_provenance",
          "is_aggregate",
          "source_id",
          "source_row",
          "ingestion_run_id",
          "data_status",
          "metadata"
        ],
        rows: plan.taxPaymentMedia.map((row) => [
          row.regionId,
          row.fiscalYear,
          row.taxCategory,
          row.paymentMethod,
          row.electronicNotice,
          row.paymentCount,
          row.paymentAmountWon,
          row.reportedMediaShare,
          row.unitOriginal,
          row.unitMultiplier,
          row.unitProvenance,
          row.isAggregate,
          sourceId(sourceIds, row.sourceKey),
          row.sourceRow,
          ingestionRunId,
          "official_observed",
          "{}"
        ]),
        conflictColumns: ["source_id", "source_row"],
        updateColumns: [
          "region_id",
          "fiscal_year",
          "tax_category",
          "payment_method",
          "electronic_notice",
          "payment_count",
          "payment_amount_won",
          "reported_media_share",
          "unit_original",
          "unit_multiplier",
          "unit_provenance",
          "is_aggregate",
          "ingestion_run_id",
          "data_status"
        ]
      })
    );

    addCounts(
      totals,
      await upsertRows(client, {
        table: "local_tax_assessment_status",
        columns: [
          "region_id",
          "fiscal_year",
          "tax_category",
          "assessed_count",
          "assessed_amount_won",
          "non_taxable_count",
          "non_taxable_amount_won",
          "unit_original",
          "unit_multiplier",
          "unit_provenance",
          "is_aggregate",
          "source_id",
          "source_row",
          "ingestion_run_id",
          "data_status",
          "metadata"
        ],
        rows: plan.taxAssessment.map((row) => [
          row.regionId,
          row.fiscalYear,
          row.taxCategory,
          row.assessedCount,
          row.assessedAmountWon,
          row.nonTaxableCount,
          row.nonTaxableAmountWon,
          row.unitOriginal,
          row.unitMultiplier,
          row.unitProvenance,
          row.isAggregate,
          sourceId(sourceIds, row.sourceKey),
          row.sourceRow,
          ingestionRunId,
          "official_observed",
          "{}"
        ]),
        conflictColumns: ["source_id", "source_row"],
        updateColumns: [
          "region_id",
          "fiscal_year",
          "tax_category",
          "assessed_count",
          "assessed_amount_won",
          "non_taxable_count",
          "non_taxable_amount_won",
          "unit_original",
          "unit_multiplier",
          "unit_provenance",
          "is_aggregate",
          "ingestion_run_id",
          "data_status"
        ]
      })
    );

    addCounts(
      totals,
      await upsertRows(client, {
        table: "local_tax_per_capita_burden",
        columns: [
          "region_id",
          "fiscal_year",
          "per_resident_amount_won",
          "per_household_amount_won",
          "total_local_tax_amount_won",
          "population_count",
          "household_count",
          "unit_original",
          "unit_multiplier",
          "unit_provenance",
          "source_id",
          "source_row",
          "ingestion_run_id",
          "data_status",
          "metadata"
        ],
        rows: plan.taxPerCapita.map((row) => [
          row.regionId,
          row.fiscalYear,
          row.perResidentAmountWon,
          row.perHouseholdAmountWon,
          row.totalLocalTaxAmountWon,
          row.populationCount,
          row.householdCount,
          row.unitOriginal,
          row.unitMultiplier,
          row.unitProvenance,
          sourceId(sourceIds, row.sourceKey),
          row.sourceRow,
          ingestionRunId,
          "official_observed",
          "{}"
        ]),
        conflictColumns: ["source_id", "source_row"],
        updateColumns: [
          "region_id",
          "fiscal_year",
          "per_resident_amount_won",
          "per_household_amount_won",
          "total_local_tax_amount_won",
          "population_count",
          "household_count",
          "unit_original",
          "unit_multiplier",
          "unit_provenance",
          "ingestion_run_id",
          "data_status"
        ]
      })
    );

    addCounts(
      totals,
      await upsertRows(client, {
        table: "local_tax_taxpayer_status",
        columns: [
          "region_id",
          "fiscal_year",
          "tax_category",
          "taxpayer_type",
          "jurisdiction_scope",
          "taxpayer_count",
          "is_aggregate",
          "source_id",
          "source_row",
          "ingestion_run_id",
          "data_status",
          "metadata"
        ],
        rows: plan.taxTaxpayer.map((row) => [
          row.regionId,
          row.fiscalYear,
          row.taxCategory,
          row.taxpayerType,
          row.jurisdictionScope,
          row.taxpayerCount,
          row.isAggregate,
          sourceId(sourceIds, row.sourceKey),
          row.sourceRow,
          ingestionRunId,
          "official_observed",
          "{}"
        ]),
        conflictColumns: ["source_id", "source_row"],
        updateColumns: [
          "region_id",
          "fiscal_year",
          "tax_category",
          "taxpayer_type",
          "jurisdiction_scope",
          "taxpayer_count",
          "is_aggregate",
          "ingestion_run_id",
          "data_status"
        ]
      })
    );

    addCounts(
      totals,
      await upsertRows(client, {
        table: "local_tax_exemption_status",
        columns: [
          "region_id",
          "fiscal_year",
          "tax_category",
          "non_taxable_amount_won",
          "reduction_amount_won",
          "assessed_amount_won",
          "reported_exemption_rate",
          "computed_exemption_rate",
          "unit_original",
          "unit_multiplier",
          "unit_provenance",
          "is_aggregate",
          "source_id",
          "source_row",
          "ingestion_run_id",
          "data_status",
          "metadata"
        ],
        rows: plan.taxExemption.map((row) => [
          row.regionId,
          row.fiscalYear,
          row.taxCategory,
          row.nonTaxableAmountWon,
          row.reductionAmountWon,
          row.assessedAmountWon,
          row.reportedExemptionRate,
          row.computedExemptionRate,
          row.unitOriginal,
          row.unitMultiplier,
          row.unitProvenance,
          row.isAggregate,
          sourceId(sourceIds, row.sourceKey),
          row.sourceRow,
          ingestionRunId,
          "official_observed",
          "{}"
        ]),
        conflictColumns: ["source_id", "source_row"],
        updateColumns: [
          "region_id",
          "fiscal_year",
          "tax_category",
          "non_taxable_amount_won",
          "reduction_amount_won",
          "assessed_amount_won",
          "reported_exemption_rate",
          "computed_exemption_rate",
          "unit_original",
          "unit_multiplier",
          "unit_provenance",
          "is_aggregate",
          "ingestion_run_id",
          "data_status"
        ]
      })
    );

    addCounts(
      totals,
      await upsertRows(client, {
        table: "local_tax_unrefunded_status",
        columns: [
          "region_id",
          "fiscal_year",
          "tax_category",
          "unrefunded_type",
          "taxpayer_type",
          "current_count",
          "current_amount_won",
          "cumulative_count",
          "cumulative_amount_won",
          "reported_cumulative_change",
          "unit_original",
          "unit_multiplier",
          "unit_provenance",
          "is_aggregate",
          "source_id",
          "source_row",
          "ingestion_run_id",
          "data_status",
          "metadata"
        ],
        rows: plan.taxUnrefunded.map((row) => [
          row.regionId,
          row.fiscalYear,
          row.taxCategory,
          row.unrefundedType,
          row.taxpayerType,
          row.currentCount,
          row.currentAmountWon,
          row.cumulativeCount,
          row.cumulativeAmountWon,
          row.reportedCumulativeChange,
          row.unitOriginal,
          row.unitMultiplier,
          row.unitProvenance,
          row.isAggregate,
          sourceId(sourceIds, row.sourceKey),
          row.sourceRow,
          ingestionRunId,
          "official_observed",
          "{}"
        ]),
        conflictColumns: ["source_id", "source_row"],
        updateColumns: [
          "region_id",
          "fiscal_year",
          "tax_category",
          "unrefunded_type",
          "taxpayer_type",
          "current_count",
          "current_amount_won",
          "cumulative_count",
          "cumulative_amount_won",
          "reported_cumulative_change",
          "unit_original",
          "unit_multiplier",
          "unit_provenance",
          "is_aggregate",
          "ingestion_run_id",
          "data_status"
        ]
      })
    );

    addCounts(
      totals,
      await upsertRows(client, {
        table: "local_tax_enforcement_statistic",
        columns: [
          "region_id",
          "fiscal_year",
          "enforcement_date",
          "agency",
          "delinquency_count",
          "delinquency_amount_won",
          "unit_original",
          "unit_multiplier",
          "unit_provenance",
          "source_id",
          "source_row",
          "ingestion_run_id",
          "data_status",
          "metadata"
        ],
        rows: plan.taxEnforcement.map((row) => [
          row.regionId,
          row.fiscalYear,
          row.enforcementDate,
          row.agency,
          row.delinquencyCount,
          row.delinquencyAmountWon,
          row.unitOriginal,
          row.unitMultiplier,
          row.unitProvenance,
          sourceId(sourceIds, row.sourceKey),
          row.sourceRow,
          ingestionRunId,
          "official_observed",
          JSON.stringify({ locationTextStored: false })
        ]),
        conflictColumns: ["source_id", "source_row"],
        updateColumns: [
          "region_id",
          "fiscal_year",
          "enforcement_date",
          "agency",
          "delinquency_count",
          "delinquency_amount_won",
          "unit_original",
          "unit_multiplier",
          "unit_provenance",
          "ingestion_run_id",
          "data_status",
          "metadata"
        ]
      })
    );

    addCounts(
      totals,
      await upsertRows(client, {
        table: "data_quality_issue",
        columns: [
          "issue_key",
          "severity",
          "issue_code",
          "entity_type",
          "source_id",
          "source_row",
          "field_name",
          "message",
          "observed",
          "expected",
          "quarantined",
          "ingestion_run_id",
          "metadata"
        ],
        rows: plan.taxQualityIssues.map((row) => [
          row.issueKey,
          row.severity,
          row.issueCode,
          row.entityType,
          sourceId(sourceIds, row.sourceKey),
          row.sourceRow,
          row.fieldName,
          row.message,
          JSON.stringify(row.observed),
          JSON.stringify(row.expected),
          row.quarantined,
          ingestionRunId,
          "{}"
        ]),
        conflictColumns: ["issue_key"],
        updateColumns: [
          "severity",
          "issue_code",
          "entity_type",
          "source_id",
          "source_row",
          "field_name",
          "message",
          "observed",
          "expected",
          "quarantined",
          "ingestion_run_id"
        ]
      })
    );

    addCounts(
      totals,
      await upsertRows(client, {
        table: "local_tax_revenue",
        columns: [
          "region_id",
          "fiscal_year",
          "tax_category",
          "revenue_amount_won",
          "accounting_basis",
          "amount_semantics",
          "source_grain",
          "unit_original",
          "unit_multiplier",
          "unit_provenance",
          "is_aggregate",
          "source_id",
          "ingestion_run_id",
          "source_row",
          "metadata",
          "data_status"
        ],
        rows: plan.localTax.map((row) => [
          row.regionId,
          row.fiscalYear,
          row.taxCategory,
          row.revenueAmountWon,
          row.accountingBasis,
          row.amountSemantics,
          row.sourceGrain,
          row.unitOriginal,
          row.unitMultiplier,
          row.unitProvenance,
          row.isAggregate,
          sourceId(sourceIds, row.sourceKey),
          ingestionRunId,
          row.sourceRow,
          JSON.stringify(row.metadata),
          row.dataStatus
        ]),
        conflictColumns: [
          "region_id",
          "fiscal_year",
          "tax_category",
          "accounting_basis",
          "source_id"
        ],
        updateColumns: [
          "revenue_amount_won",
          "amount_semantics",
          "source_grain",
          "unit_original",
          "unit_multiplier",
          "unit_provenance",
          "is_aggregate",
          "ingestion_run_id",
          "source_row",
          "metadata",
          "data_status"
        ]
      })
    );

    addCounts(
      totals,
      await upsertRows(client, {
        table: "policy_program",
        columns: [
          "policy_id",
          "region_id",
          "title",
          "managing_organization",
          "target_age_min",
          "target_age_max",
          "industries",
          "stages",
          "eligibility_text",
          "support_text",
          "application_start",
          "application_end",
          "source_id",
          "ingestion_run_id",
          "data_status",
          "metadata"
        ],
        rows: plan.policies.map((row) => [
          row.policyId,
          row.regionId,
          row.title,
          row.managingOrganization,
          row.targetAgeMin,
          row.targetAgeMax,
          row.industries,
          row.stages,
          row.eligibilityText,
          row.supportText,
          row.applicationStart,
          row.applicationEnd,
          sourceId(sourceIds, row.sourceKey),
          ingestionRunId,
          row.dataStatus,
          JSON.stringify(row.metadata)
        ]),
        conflictColumns: ["policy_id"],
        updateColumns: [
          "region_id",
          "title",
          "managing_organization",
          "target_age_min",
          "target_age_max",
          "industries",
          "stages",
          "eligibility_text",
          "support_text",
          "application_start",
          "application_end",
          "source_id",
          "ingestion_run_id",
          "data_status",
          "metadata"
        ]
      })
    );

    addCounts(
      totals,
      await upsertRows(client, {
        table: "council_record",
        columns: [
          "council_record_id",
          "region_id",
          "council_name",
          "session_name",
          "meeting_date",
          "agenda_number",
          "title",
          "proposer",
          "resolution",
          "source_id",
          "ingestion_run_id",
          "data_status",
          "metadata"
        ],
        rows: plan.council.map((row) => [
          row.councilRecordId,
          row.regionId,
          row.councilName,
          row.sessionName,
          row.meetingDate,
          row.agendaNumber,
          row.title,
          row.proposer,
          row.resolution,
          sourceId(sourceIds, row.sourceKey),
          ingestionRunId,
          row.dataStatus,
          JSON.stringify(row.metadata)
        ]),
        conflictColumns: ["council_record_id"],
        updateColumns: [
          "region_id",
          "council_name",
          "session_name",
          "meeting_date",
          "agenda_number",
          "title",
          "proposer",
          "resolution",
          "source_id",
          "ingestion_run_id",
          "data_status",
          "metadata"
        ]
      })
    );

    addCounts(
      totals,
      await upsertRows(client, {
        table: "source_locator",
        columns: [
          "source_id",
          "entity_type",
          "entity_key",
          "page_number",
          "row_number",
          "section_name",
          "character_start",
          "character_end",
          "locator_text"
        ],
        rows: plan.locators.map((row) => [
          sourceId(sourceIds, row.sourceKey),
          row.entityType,
          row.entityKey,
          row.pageNumber,
          row.rowNumber,
          row.sectionName,
          row.characterStart,
          row.characterEnd,
          row.locatorText
        ]),
        conflictColumns: ["source_id", "entity_type", "entity_key"],
        updateColumns: [
          "page_number",
          "row_number",
          "section_name",
          "character_start",
          "character_end",
          "locator_text"
        ]
      })
    );

    await client.query("COMMIT");
    transactionStarted = false;
    const status = plan.rejected.length > 0 ? "partial" : "succeeded";
    await client.query(
      `UPDATE ingestion_run
          SET finished_at = now(),
              status = $2,
              inserted_count = $3,
              updated_count = $4,
              error_count = $5,
              error_report = $6::jsonb
        WHERE ingestion_run_id = $1`,
      [
        ingestionRunId,
        status,
        totals.inserted,
        totals.updated,
        plan.rejected.length,
        JSON.stringify(plan.rejected.slice(0, 200))
      ]
    );

    return {
      ingestionRunId,
      status,
      insertedCount: totals.inserted,
      updatedCount: totals.updated,
      errorCount: plan.rejected.length,
      planCounts: {
        regions: plan.regions.length,
        sources: plan.sources.length,
        population: plan.population.length,
        localTax: plan.localTax.length,
        taxCollection: plan.taxCollection.length,
        taxPaymentMedia: plan.taxPaymentMedia.length,
        taxAssessment: plan.taxAssessment.length,
        taxPerCapita: plan.taxPerCapita.length,
        taxTaxpayer: plan.taxTaxpayer.length,
        taxExemption: plan.taxExemption.length,
        taxUnrefunded: plan.taxUnrefunded.length,
        taxEnforcement: plan.taxEnforcement.length,
        taxQualityIssues: plan.taxQualityIssues.length,
        policies: plan.policies.length,
        council: plan.council.length,
        locators: plan.locators.length
      },
      integrity: await integrityCounts(client)
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original database error is more useful than rollback failure.
      }
    }
    const issue = classifyDatabaseError(error);
    if (ingestionRunId) {
      try {
        await client.query(
          `UPDATE ingestion_run
              SET finished_at = now(),
                  status = 'failed',
                  error_count = $2,
                  error_report = $3::jsonb
            WHERE ingestion_run_id = $1`,
          [
            ingestionRunId,
            plan.rejected.length + 1,
            JSON.stringify([
              ...plan.rejected.slice(0, 199),
              { entityType: "database", sourcePath: "", sourceRow: null, reason: issue }
            ])
          ]
        );
      } catch {
        // Failure recording is best-effort when the database itself is unavailable.
      }
    }
    throw new DatabaseOperationError(issue);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function applySchemaToDatabase(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await applyDatabaseSchema(client);
  } catch (error) {
    throw new DatabaseOperationError(classifyDatabaseError(error));
  } finally {
    await client.end().catch(() => undefined);
  }
}
