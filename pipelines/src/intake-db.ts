import { Client } from "pg";
import { classifyDatabaseError, DatabaseOperationError } from "./db.js";
import type { IntakeRunResult } from "./intake.js";

export interface IntakeLedgerResult {
  ingestionRunId: string;
  recordedFiles: number;
  status: "succeeded" | "partial";
}

/**
 * Persists one intake run as an `ingestion_run` plus its per-file decisions.
 * The ledger is the durable answer to "which raw files arrived and what
 * happened to them", including files that were rejected before normalization.
 */
export async function recordIntakeRun(
  databaseUrl: string,
  run: IntakeRunResult
): Promise<IntakeLedgerResult> {
  if (run.mode === "dry-run") {
    throw new Error("A dry-run intake result must not be written to the ledger");
  }
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (error) {
    throw new DatabaseOperationError(classifyDatabaseError(error));
  }
  try {
    await client.query("BEGIN");
    const status = run.counts.quarantined > 0 ? "partial" : "succeeded";
    const errorReport = run.decisions
      .filter((decision) => decision.action === "quarantined")
      .map((decision) => ({
        fileName: decision.fileName,
        sha256: decision.sha256,
        rejectionCode: decision.rejectionCode,
        rejectionMessage: decision.rejectionMessage
      }));

    const inserted = await client.query<{ ingestion_run_id: string }>(
      `INSERT INTO ingestion_run (
         ingestion_run_id, pipeline_name, pipeline_version, started_at, finished_at,
         status, inserted_count, updated_count, error_count, error_report
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9::jsonb)
       ON CONFLICT (ingestion_run_id) DO UPDATE
         SET finished_at = EXCLUDED.finished_at,
             status = EXCLUDED.status,
             inserted_count = EXCLUDED.inserted_count,
             error_count = EXCLUDED.error_count,
             error_report = EXCLUDED.error_report
       RETURNING ingestion_run_id`,
      [
        run.runId,
        run.pipelineName,
        run.pipelineVersion,
        run.startedAt,
        run.finishedAt,
        status,
        run.counts.accepted + run.counts.revision,
        run.counts.quarantined,
        JSON.stringify(errorReport)
      ]
    );
    const ingestionRunId = inserted.rows[0]!.ingestion_run_id;

    await client.query("DELETE FROM raw_intake_file WHERE ingestion_run_id = $1", [
      ingestionRunId
    ]);

    for (const decision of run.decisions) {
      await client.query(
        `INSERT INTO raw_intake_file (
           ingestion_run_id, file_name, file_sha256, byte_size, media_type,
           content_kind, encoding, reference_date, action, stored_path,
           duplicate_of_path, rejection_code, rejection_message, received_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          ingestionRunId,
          decision.fileName,
          decision.sha256,
          decision.byteSize,
          decision.mediaType,
          decision.contentKind,
          decision.encoding,
          decision.referenceDate,
          decision.action,
          decision.storedPath,
          decision.duplicateOfPath,
          decision.rejectionCode,
          decision.rejectionMessage,
          run.startedAt
        ]
      );
    }

    await client.query("COMMIT");
    return {
      ingestionRunId,
      recordedFiles: run.decisions.length,
      status
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new DatabaseOperationError(classifyDatabaseError(error));
  } finally {
    await client.end();
  }
}

export interface IntakeLedgerSummaryRow {
  action: string;
  files: number;
  lastReceivedAt: string | null;
}

export async function summarizeIntakeLedger(
  databaseUrl: string
): Promise<IntakeLedgerSummaryRow[]> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (error) {
    throw new DatabaseOperationError(classifyDatabaseError(error));
  }
  try {
    const result = await client.query<{
      action: string;
      files: string;
      last_received_at: Date | null;
    }>(
      `SELECT action, count(*) AS files, max(received_at) AS last_received_at
         FROM raw_intake_file
        GROUP BY action
        ORDER BY action`
    );
    return result.rows.map((row) => ({
      action: row.action,
      files: Number(row.files),
      lastReceivedAt: row.last_received_at?.toISOString() ?? null
    }));
  } finally {
    await client.end();
  }
}
