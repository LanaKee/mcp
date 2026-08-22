import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { recordIntakeRun, summarizeIntakeLedger } from "./intake-db.js";
import type { IntakeDecision, IntakeRunResult } from "./intake.js";

const connectionString = process.env.TEST_DATABASE_URL;
const describeDatabase = connectionString ? describe.sequential : describe.skip;
const suffix = randomUUID().slice(0, 8);
const runIds: string[] = [];
let client: Client;

function decision(overrides: Partial<IntakeDecision>): IntakeDecision {
  return {
    fileName: `intake-fixture-${suffix}.csv`,
    inboxPath: `data/intake/inbox/intake-fixture-${suffix}.csv`,
    sha256: "a".repeat(64),
    byteSize: 128,
    mediaType: "text/csv",
    contentKind: "local_tax_payment_media",
    encoding: "utf8",
    referenceDate: "2024-12-31",
    action: "accepted",
    storedPath: `datasets/local-tax/intake-fixture-${suffix}.csv`,
    duplicateOfPath: null,
    rejectionCode: null,
    rejectionMessage: null,
    ...overrides
  };
}

function runResult(decisions: IntakeDecision[], runId: string): IntakeRunResult {
  return {
    runId,
    pipelineName: "dataset-intake",
    pipelineVersion: "intake-v1",
    mode: "write",
    startedAt: "2026-08-22T00:00:00.000Z",
    finishedAt: "2026-08-22T00:00:05.000Z",
    inboxDirectory: "data/intake/inbox",
    counts: {
      accepted: decisions.filter((item) => item.action === "accepted").length,
      revision: decisions.filter((item) => item.action === "revision").length,
      duplicate: decisions.filter((item) => item.action === "duplicate").length,
      quarantined: decisions.filter((item) => item.action === "quarantined").length
    },
    decisions,
    manifestPath: "data/intake/manifests/fixture.json"
  };
}

async function cleanup(): Promise<void> {
  if (runIds.length === 0) return;
  await client.query("DELETE FROM raw_intake_file WHERE ingestion_run_id = ANY($1::uuid[])", [
    runIds
  ]);
  await client.query("DELETE FROM ingestion_run WHERE ingestion_run_id = ANY($1::uuid[])", [
    runIds
  ]);
}

describeDatabase("intake ledger", () => {
  beforeAll(async () => {
    client = new Client({ connectionString });
    await client.connect();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  it("records every decision and marks a clean run as succeeded", async () => {
    const runId = randomUUID();
    runIds.push(runId);
    const result = await recordIntakeRun(
      connectionString!,
      runResult(
        [
          decision({}),
          decision({
            fileName: `intake-fixture-dup-${suffix}.csv`,
            sha256: "b".repeat(64),
            action: "duplicate",
            storedPath: null,
            duplicateOfPath: `datasets/local-tax/intake-fixture-${suffix}.csv`
          })
        ],
        runId
      )
    );

    expect(result.status).toBe("succeeded");
    expect(result.recordedFiles).toBe(2);
    const rows = await client.query<{ action: string; stored_path: string | null }>(
      "SELECT action, stored_path FROM raw_intake_file WHERE ingestion_run_id = $1 ORDER BY action",
      [runId]
    );
    expect(rows.rows.map((row) => row.action)).toEqual(["accepted", "duplicate"]);
    const run = await client.query<{ status: string; inserted_count: number }>(
      "SELECT status, inserted_count FROM ingestion_run WHERE ingestion_run_id = $1",
      [runId]
    );
    expect(run.rows[0]).toMatchObject({ status: "succeeded", inserted_count: 1 });
  });

  it("marks a run with quarantined files as partial and keeps the reasons", async () => {
    const runId = randomUUID();
    runIds.push(runId);
    const result = await recordIntakeRun(
      connectionString!,
      runResult(
        [
          decision({
            fileName: `intake-fixture-bad-${suffix}.csv`,
            sha256: "c".repeat(64),
            contentKind: "unknown",
            encoding: null,
            referenceDate: null,
            action: "quarantined",
            storedPath: null,
            rejectionCode: "html_error_page",
            rejectionMessage: "Payload is an HTML page rather than the requested dataset"
          })
        ],
        runId
      )
    );

    expect(result.status).toBe("partial");
    const run = await client.query<{ status: string; error_report: unknown[] }>(
      "SELECT status, error_report FROM ingestion_run WHERE ingestion_run_id = $1",
      [runId]
    );
    expect(run.rows[0]!.status).toBe("partial");
    expect(run.rows[0]!.error_report).toHaveLength(1);
  });

  it("is idempotent when the same run is recorded twice", async () => {
    const runId = randomUUID();
    runIds.push(runId);
    const payload = runResult(
      [
        decision({
          sha256: "d".repeat(64),
          storedPath: `datasets/misc/idempotent-${suffix}.csv`
        })
      ],
      runId
    );

    await recordIntakeRun(connectionString!, payload);
    await recordIntakeRun(connectionString!, payload);

    const rows = await client.query<{ count: string }>(
      "SELECT count(*) FROM raw_intake_file WHERE ingestion_run_id = $1",
      [runId]
    );
    expect(Number(rows.rows[0]!.count)).toBe(1);
  });

  it("refuses to store a dry-run result", async () => {
    const payload = runResult([decision({})], randomUUID());
    await expect(
      recordIntakeRun(connectionString!, { ...payload, mode: "dry-run" })
    ).rejects.toThrow(/dry-run/);
  });

  it("rejects a second ledger row claiming the same stored path", async () => {
    const runId = randomUUID();
    runIds.push(runId);
    await recordIntakeRun(
      connectionString!,
      runResult(
        [decision({ sha256: "e".repeat(64), storedPath: `datasets/misc/clash-${suffix}.csv` })],
        runId
      )
    );

    const otherRunId = randomUUID();
    runIds.push(otherRunId);
    await expect(
      recordIntakeRun(
        connectionString!,
        runResult(
          [
            decision({
              sha256: "f".repeat(64),
              storedPath: `datasets/misc/clash-${suffix}.csv`
            })
          ],
          otherRunId
        )
      )
    ).rejects.toThrow();
  });

  it("summarizes the ledger by action", async () => {
    const summary = await summarizeIntakeLedger(connectionString!);
    expect(summary.some((row) => row.action === "accepted")).toBe(true);
  });
});
