import { createHash } from "node:crypto";
import { Client } from "pg";
import {
  applyDatabaseSchema,
  classifyDatabaseError,
  DatabaseOperationError,
  upsertRows,
  type IntegrityCount,
  type UpsertResult
} from "./db.js";
import {
  embedChangedChunks,
  type EmbeddingProvider
} from "./embeddings.js";
import type { PlannedSource } from "./load-plan.js";
import type { PdfNormalizationPlan } from "./pdf.js";
import { GYEONGBUK_REGIONS } from "./regions.js";

export interface PdfDatabaseLoadResult {
  ingestionRunId: string;
  status: "succeeded" | "partial";
  insertedCount: number;
  updatedCount: number;
  errorCount: number;
  embeddingsGenerated: number;
  embeddingsSkipped: number;
  integrity: IntegrityCount[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function addCounts(
  totals: { inserted: number; updated: number },
  result: UpsertResult
): void {
  totals.inserted += result.inserted;
  totals.updated += result.updated;
}

function sourceId(sourceIds: Map<string, string>, sourceKey: string): string {
  const value = sourceIds.get(sourceKey);
  if (!value) throw new Error(`Missing loaded PDF source mapping for ${sourceKey}`);
  return value;
}

async function existingEmbeddingHashes(
  client: Client,
  plan: PdfNormalizationPlan,
  provider: EmbeddingProvider
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const ids = plan.chunks.map((chunk) => chunk.chunkId);
  const batchSize = 5000;
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const result = await client.query<{
      chunk_id: string;
      content_sha256: string;
    }>(
      `SELECT chunk_id::text, content_sha256::text
         FROM document_chunk_embedding
        WHERE provider = $1
          AND model = $2
          AND model_version = $3
          AND dimensions = $4
          AND chunk_id = ANY($5::uuid[])`,
      [
        provider.descriptor.provider,
        provider.descriptor.model,
        provider.descriptor.version,
        provider.descriptor.dimensions,
        ids.slice(offset, offset + batchSize)
      ]
    );
    for (const row of result.rows) hashes.set(row.chunk_id, row.content_sha256);
  }
  return hashes;
}

async function pdfIntegrity(client: Client): Promise<IntegrityCount[]> {
  const result = await client.query<{
    table_name: string;
    data_status: string;
    row_count: string;
  }>(`
    SELECT 'document' AS table_name, extraction_status AS data_status, count(*)::text AS row_count
      FROM document GROUP BY extraction_status
    UNION ALL
    SELECT 'document_chunk', 'all', count(*)::text FROM document_chunk
    UNION ALL
    SELECT 'document_chunk_embedding',
           provider || ':' || model || ':' || model_version,
           count(*)::text
      FROM document_chunk_embedding
      GROUP BY provider, model, model_version
    UNION ALL
    SELECT 'source_locator', entity_type, count(*)::text
      FROM source_locator
      WHERE entity_type IN ('document', 'document_chunk', 'pdf_page_status')
      GROUP BY entity_type
    ORDER BY 1, 2
  `);
  return result.rows.map((row) => ({
    tableName: row.table_name,
    dataStatus: row.data_status,
    rowCount: Number(row.row_count)
  }));
}

function sourceRows(sources: PlannedSource[]): unknown[][] {
  return sources.map((row) => [
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
  ]);
}

export async function loadPdfDatabase(
  databaseUrl: string,
  plan: PdfNormalizationPlan,
  provider: EmbeddingProvider,
  options: {
    applySchema?: boolean;
    embeddingBatchSize?: number;
    onEmbeddingProgress?: (progress: {
      generated: number;
      skipped: number;
      total: number;
    }) => void;
  } = {}
): Promise<PdfDatabaseLoadResult> {
  const client = new Client({ connectionString: databaseUrl });
  let ingestionRunId: string | null = null;
  let transactionStarted = false;
  try {
    await client.connect();
    if (options.applySchema !== false) await applyDatabaseSchema(client);
    const inputSha256 = sha256(
      JSON.stringify({
        documents: plan.documents.map((document) => [
          document.documentKey,
          document.contentSha256,
          document.extractionStatus
        ]),
        chunks: plan.chunks.map((chunk) => [chunk.chunkId, chunk.contentSha256]),
        provider: provider.descriptor
      })
    );
    const run = await client.query<{ ingestion_run_id: string }>(
      `INSERT INTO ingestion_run
        (pipeline_name, pipeline_version, status, input_sha256, error_count, error_report)
       VALUES ($1, $2, 'running', $3, $4, $5::jsonb)
       RETURNING ingestion_run_id`,
      [
        "gyeongbuk-pdf-normalizer",
        "0.1.0",
        inputSha256,
        plan.failures.length,
        JSON.stringify(plan.failures.slice(0, 200))
      ]
    );
    ingestionRunId = run.rows[0]!.ingestion_run_id;

    const existing = await existingEmbeddingHashes(client, plan, provider);
    const embedded = await embedChangedChunks(provider, plan.chunks, existing, {
      batchSize: options.embeddingBatchSize,
      onProgress: options.onEmbeddingProgress
    });

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
        rows: GYEONGBUK_REGIONS.map((region) => [
          region.regionId,
          region.regionName,
          region.regionType,
          region.parentRegionId,
          region.regionName.replace(/\s+/gu, "")
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
      rows: sourceRows(plan.sources),
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
        table: "document",
        columns: [
          "document_id",
          "document_key",
          "region_id",
          "document_type",
          "title",
          "organization",
          "published_date",
          "source_id",
          "ingestion_run_id",
          "extraction_status",
          "page_count",
          "content_sha256",
          "data_status",
          "metadata"
        ],
        rows: plan.documents.map((row) => [
          row.documentId,
          row.documentKey,
          row.regionId,
          row.documentType,
          row.title,
          row.organization,
          row.publishedDate,
          sourceId(sourceIds, row.sourceKey),
          ingestionRunId,
          row.extractionStatus,
          row.pageCount,
          row.contentSha256,
          row.dataStatus,
          JSON.stringify(row.metadata)
        ]),
        conflictColumns: ["document_id"],
        updateColumns: [
          "document_key",
          "region_id",
          "document_type",
          "title",
          "organization",
          "published_date",
          "source_id",
          "ingestion_run_id",
          "extraction_status",
          "page_count",
          "content_sha256",
          "data_status",
          "metadata"
        ]
      })
    );

    await client.query(
      "UPDATE document_chunk SET is_current = false WHERE document_id = ANY($1::uuid[])",
      [plan.documents.map((document) => document.documentId)]
    );

    addCounts(
      totals,
      await upsertRows(client, {
        table: "document_chunk",
        columns: [
          "chunk_id",
          "chunk_key",
          "document_id",
          "chunk_index",
          "page_start",
          "page_end",
          "section_title",
          "content",
          "content_sha256",
          "token_count",
          "ingestion_run_id",
          "is_current",
          "metadata"
        ],
        rows: plan.chunks.map((row) => [
          row.chunkId,
          row.chunkKey,
          row.documentId,
          row.chunkIndex,
          row.pageStart,
          row.pageEnd,
          row.sectionTitle,
          row.content,
          row.contentSha256,
          row.tokenCount,
          ingestionRunId,
          true,
          JSON.stringify(row.metadata)
        ]),
        conflictColumns: ["chunk_id"],
        updateColumns: [
          "chunk_key",
          "document_id",
          "chunk_index",
          "page_start",
          "page_end",
          "section_title",
          "content",
          "content_sha256",
          "token_count",
          "ingestion_run_id",
          "is_current",
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

    addCounts(
      totals,
      await upsertRows(client, {
        table: "document_chunk_embedding",
        columns: [
          "chunk_id",
          "provider",
          "model",
          "model_version",
          "dimensions",
          "retrieval_mode",
          "embedding",
          "content_sha256",
          "metadata"
        ],
        rows: embedded.embeddings.map((row) => [
          row.chunkId,
          row.provider,
          row.model,
          row.version,
          row.dimensions,
          row.retrievalMode,
          row.embedding,
          row.contentSha256,
          JSON.stringify(row.metadata)
        ]),
        conflictColumns: ["chunk_id", "provider", "model", "model_version"],
        updateColumns: [
          "dimensions",
          "retrieval_mode",
          "embedding",
          "content_sha256",
          "generated_at",
          "metadata"
        ]
      })
    );

    await client.query("COMMIT");
    transactionStarted = false;
    const status = plan.failures.length > 0 ? "partial" : "succeeded";
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
        plan.failures.length,
        JSON.stringify(plan.failures.slice(0, 200))
      ]
    );
    return {
      ingestionRunId,
      status,
      insertedCount: totals.inserted,
      updatedCount: totals.updated,
      errorCount: plan.failures.length,
      embeddingsGenerated: embedded.embeddings.length,
      embeddingsSkipped: embedded.skipped,
      integrity: await pdfIntegrity(client)
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Keep the original error.
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
            plan.failures.length + 1,
            JSON.stringify([
              ...plan.failures.slice(0, 199),
              { sourcePath: "", status: "extraction_failed", error: issue }
            ])
          ]
        );
      } catch {
        // Failure recording is best-effort.
      }
    }
    throw new DatabaseOperationError(issue);
  } finally {
    await client.end().catch(() => undefined);
  }
}
